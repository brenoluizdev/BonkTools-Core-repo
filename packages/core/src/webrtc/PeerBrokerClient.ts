/**
 * PeerBrokerClient — participa do handshake WebRTC/PeerJS que o bonk.io usa pra
 * sincronizar a partida ao vivo entre os clients (peer-to-peer, fora do Socket.IO).
 *
 * Descoberto via captura de tráfego real (não documentado antes): quando um jogador
 * entra numa sala, o client dele abre uma conexão WebRTC com CADA peer já presente —
 * inclusive o host, mesmo que o host nunca jogue. Sem essa lib, o host do bonktools
 * nunca respondia a esse handshake: o OFFER endereçado a ele expirava
 * (`{"type":"EXPIRE",...}`) e o jogador ficava sem conseguir renderizar a partida.
 *
 * Confirmado comparando: (a) host real (navegador) responde ANSWER normalmente, sem
 * EXPIRE; (b) host bonktools sem esta lib, mesmo OFFER expira. Ver BONK_PROTOCOL.md.
 *
 * Escopo (Fase A): só completar o handshake de sinalização (OPEN/OFFER/ANSWER/
 * CANDIDATE/HEARTBEAT) pra não deixar a conexão expirar. NÃO relaya dados de física
 * pelo DataChannel — se isso for necessário (Fase B), é trabalho futuro.
 *
 * Protocolo: servidor PeerJS padrão, sem customização (key="peerjs", formato de
 * id/token idêntico ao client PeerJS oficial) — confirmado inspecionando a URL de
 * conexão real: wss://<server>.bonk.io/myapp/peerjs?key=peerjs&id=<peerID>&token=<token>.
 */

import { EventEmitter } from 'eventemitter3';
import WebSocket from 'ws';
import { RTCPeerConnection } from 'werift';
import type { Logger } from 'pino';

const HEARTBEAT_INTERVAL_MS = 5000;
const RECONNECT_DELAY_MS = 3000;

/** Gera um token de sessão no mesmo formato do client PeerJS oficial (~11 chars base36). */
function generateToken(): string {
  return Math.random().toString(36).slice(2);
}

interface OfferPayload {
  sdp: { sdp: string; type: 'offer' };
  type: 'data';
  connectionId: string;
  browser?: string;
  label?: string;
  reliable?: boolean;
  serialization?: string;
}

interface CandidatePayload {
  candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null };
  type: 'data';
  connectionId: string;
}

type BrokerMessage =
  | { type: 'OPEN' }
  | { type: 'OFFER'; src: string; dst: string; payload: OfferPayload }
  | { type: 'ANSWER'; src: string; dst: string; payload: { sdp: { sdp: string; type: 'answer' }; type: 'data'; connectionId: string } }
  | { type: 'CANDIDATE'; src: string; dst: string; payload: CandidatePayload }
  | { type: 'EXPIRE'; src: string; dst: string }
  | { type: 'HEARTBEAT' }
  | { type: string; [key: string]: unknown };

interface PeerConnEntry {
  pc: RTCPeerConnection;
  connectionId: string;
}

export interface PeerBrokerClientEvents {
  open: [];
  error: [Error];
  close: [];
}

/**
 * Um `PeerBrokerClient` por sala — usa o mesmo `peerID` já enviado em CREATE_ROOM/
 * JOIN_ROOM (`AuthClient.generatePeerID()`), então outros peers já sabem pra quem
 * endereçar o OFFER assim que recebem o roster via PLAYER_JOIN/ROOM_JOIN.
 */
export class PeerBrokerClient extends EventEmitter<PeerBrokerClientEvents> {
  private ws: WebSocket | null = null;
  private readonly connections = new Map<string, PeerConnEntry>(); // key = src peerID
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly server: string,
    private readonly peerID: string,
    private readonly logger: Logger,
  ) {
    super();
  }

  connect(): void {
    if (this.closed) return;
    const token = generateToken();
    const url = `wss://${this.server}.bonk.io/myapp/peerjs?key=peerjs&id=${this.peerID}&token=${token}`;
    const ws = new WebSocket(url, { rejectUnauthorized: false });
    this.ws = ws;

    ws.on('open', () => {
      this.startHeartbeat();
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: BrokerMessage;
      try {
        msg = JSON.parse(raw.toString()) as BrokerMessage;
      } catch {
        this.logger.warn({ raw: raw.toString().slice(0, 200) }, '[peer-broker] mensagem não-JSON ignorada');
        return;
      }
      void this.handleMessage(msg);
    });

    ws.on('close', () => {
      this.stopHeartbeat();
      this.emit('close');
      if (!this.closed) {
        setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    });

    ws.on('error', (err: Error) => {
      this.logger.warn({ err: err.message }, '[peer-broker] erro no socket do broker');
      this.emit('error', err);
    });
  }

  disconnect(): void {
    this.closed = true;
    this.stopHeartbeat();
    for (const { pc } of this.connections.values()) {
      pc.close();
    }
    this.connections.clear();
    this.ws?.close();
    this.ws = null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'HEARTBEAT' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async handleMessage(msg: BrokerMessage): Promise<void> {
    switch (msg.type) {
      case 'OPEN':
        this.emit('open');
        break;

      case 'OFFER':
        await this.handleOffer(msg as Extract<BrokerMessage, { type: 'OFFER' }>);
        break;

      case 'CANDIDATE':
        this.handleCandidate(msg as Extract<BrokerMessage, { type: 'CANDIDATE' }>);
        break;

      case 'EXPIRE':
        // Não deveria mais acontecer do nosso lado depois deste fix — pode acontecer
        // se o peer remoto sair antes do handshake completar (condição normal).
        this.logger.debug({ src: (msg as { src?: string }).src }, '[peer-broker] EXPIRE recebido');
        break;

      default:
        // HEARTBEAT (eco do servidor, se houver) ou tipos não mapeados — sem ação.
        break;
    }
  }

  private async handleOffer(msg: Extract<BrokerMessage, { type: 'OFFER' }>): Promise<void> {
    const { src, payload } = msg;
    const existing = this.connections.get(src);
    if (existing) {
      existing.pc.close();
      this.connections.delete(src);
    }

    const pc = new RTCPeerConnection();
    const entry: PeerConnEntry = { pc, connectionId: payload.connectionId };
    this.connections.set(src, entry);

    pc.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (!candidate) return;
      this.send({
        type: 'CANDIDATE',
        dst: src,
        payload: {
          candidate: {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
          },
          type: 'data',
          connectionId: payload.connectionId,
        },
      });
    };

    pc.ondatachannel = () => {
      // Fase A: só mantém o canal aberto (o handshake em si já resolve o EXPIRE).
      // Relay de dados de física fica pra Fase B, se necessário.
      this.logger.debug({ src }, '[peer-broker] data channel aberto (sem relay — Fase A)');
    };

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.send({
        type: 'ANSWER',
        dst: src,
        payload: {
          sdp: { sdp: pc.localDescription!.sdp, type: 'answer' },
          type: 'data',
          connectionId: payload.connectionId,
        },
      });
    } catch (err) {
      this.logger.warn({ src, err: (err as Error).message }, '[peer-broker] falha respondendo OFFER');
      pc.close();
      this.connections.delete(src);
    }
  }

  private handleCandidate(msg: Extract<BrokerMessage, { type: 'CANDIDATE' }>): void {
    const entry = this.connections.get(msg.src);
    if (!entry) return;
    const c = msg.payload.candidate;
    void entry.pc.addIceCandidate({
      candidate: c.candidate,
      sdpMid: c.sdpMid ?? undefined,
      sdpMLineIndex: c.sdpMLineIndex ?? undefined,
    });
  }
}
