// PeerJS wrapper for the Pokemon TCG B&B mini lobby. Default broker is the
// free PeerJS Cloud; passing a PeerServerConfig targets a self-hosted
// peerjs-server so players on the same wifi can connect without internet.
//
// Lobby codes: the host registers a readable peer id `pkm-bnb-<CODE>`; guests
// dial that id directly. Collisions (another lobby already owns the code on
// the broker) auto-retry with a fresh code.

import Peer from 'peerjs'
import type { DataConnection } from 'peerjs'
import { PROTOCOL_VERSION, isNetMessage, type NetMessage, type PlayerSlot } from './protocol'

export type PeerServerConfig = {
  host: string
  port: number
  path: string
  secure: boolean
}

/** `null` = PeerJS Cloud (default, free, needs internet). */
export type ServerChoice = PeerServerConfig | null

export type PeerStatus = 'connecting' | 'waiting' | 'connected' | 'error' | 'closed'

export type SessionCallbacks = {
  onMessage: (message: NetMessage) => void
  /** `slot` is the seat that opened: 'guest' in v1, more seats later. */
  onPeerConnected: (slot: PlayerSlot) => void
  onPeerDisconnected: () => void
  onStatus: (status: PeerStatus) => void
  onError: (message: string) => void
}

export type SessionBase = {
  /** Short shareable lobby code (host) — guests dial `pkm-bnb-<CODE>`. */
  code: string
  dispose: () => void
  send: (message: NetMessage) => void
}

export type HostSession = SessionBase & { role: 'host' }
export type GuestSession = SessionBase & { role: 'guest' }

const PEER_PREFIX = 'pkm-bnb-'
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
const CODE_RETRY_LIMIT = 5

export function randomCode(length = CODE_LENGTH): string {
  let code = ''
  for (let index = 0; index < length; index++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return code
}

/** Parse a user-entered self-hosted server address into a PeerServerConfig. */
export function parseServerAddress(input: string): PeerServerConfig | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  // No scheme -> plain http (typical LAN peerjs-server); https/wss opt in via scheme.
  const url = trimmed.includes('://') ? trimmed : `http://${trimmed}`
  try {
    const parsed = new URL(url)
    const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:'
    return {
      host: parsed.hostname,
      port: Number(parsed.port) || (secure ? 443 : 80),
      path: (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')) || '/peerjs',
      secure,
    }
  } catch {
    return null
  }
}

type WireCallbacks = Partial<SessionCallbacks>

function attachConnection(conn: DataConnection, callbacks: WireCallbacks) {
  conn.on('data', (data) => {
    if (isNetMessage(data)) {
      callbacks.onMessage?.(data)
      return
    }
    // A handshake that failed validation is almost always a version skew: the
    // other build speaks a different protocol. Surface it instead of hanging.
    const candidate = data as { kind?: unknown } | null | undefined
    if (candidate && typeof candidate === 'object' && (candidate.kind === 'hello' || candidate.kind === 'hello-ack')) {
      callbacks.onStatus?.('error')
      callbacks.onError?.('protocol-mismatch')
    }
  })
  conn.on('close', () => callbacks.onPeerDisconnected?.())
  conn.on('error', () => callbacks.onPeerDisconnected?.())
}

function makePeer(id: string | undefined, server: ServerChoice): Peer {
  const serverOptions = server
    ? { host: server.host, port: server.port, path: server.path, secure: server.secure }
    : undefined
  if (id) return serverOptions ? new Peer(id, serverOptions) : new Peer(id)
  return serverOptions ? new Peer(serverOptions) : new Peer()
}

/** Host a lobby: registers a readable peer id and waits for one guest. */
export function createHost(callbacks: WireCallbacks, server: ServerChoice = null, requestedCode?: string): HostSession {
  let disposed = false
  let peer: Peer | null = null
  let conn: DataConnection | null = null
  let hasGuest = false
  let attempts = 0
  // Updated on every (re)spawn so `code` stays correct through id collisions.
  let pendingCode = (requestedCode ?? randomCode()).toUpperCase()

  const cleanup = () => {
    try { conn?.close() } catch { /* already gone */ }
    conn = null
    hasGuest = false
    try { peer?.destroy() } catch { /* already gone */ }
    peer = null
  }

  const spawn = (code: string) => {
    if (disposed) return
    pendingCode = code
    callbacks.onStatus?.('connecting')
    peer = makePeer(PEER_PREFIX + code, server)
    peer.on('open', () => {
      if (disposed) return
      callbacks.onStatus?.('waiting')
    })
    peer.on('connection', (incoming) => {
      if (disposed || hasGuest) {
        // Only one guest seat in v1; politely close extra dials.
        incoming.on('open', () => incoming.close())
        return
      }
      const link = incoming
      conn = link
      attachConnection(link, callbacks)
      link.on('open', () => {
        if (disposed || conn !== link) return
        hasGuest = true
        callbacks.onPeerConnected?.('guest')
        callbacks.onStatus?.('connected')
      })
      link.on('close', () => {
        if (conn === link) conn = null
        hasGuest = false
        callbacks.onStatus?.('waiting')
      })
    })
    peer.on('error', (error) => {
      if (disposed) return
      const type = (error as { type?: string }).type
      if (type === 'unavailable-id' && attempts < CODE_RETRY_LIMIT) {
        attempts += 1
        cleanup()
        spawn(randomCode())
        return
      }
      callbacks.onStatus?.('error')
      callbacks.onError?.(type ?? error.message)
    })
    peer.on('disconnected', () => { if (!disposed) peer?.reconnect() })
  }

  spawn(pendingCode)

  return {
    role: 'host',
    get code() {
      const registered = peer?.id
      return registered && registered.startsWith(PEER_PREFIX) ? registered.slice(PEER_PREFIX.length) : pendingCode
    },
    send(message) {
      if (conn && conn.open) conn.send(message)
    },
    dispose() {
      disposed = true
      callbacks.onStatus?.('closed')
      cleanup()
    },
  }
}

/** Join a lobby by its short code. Sends `hello` once the channel opens. */
export function joinHost(code: string, name: string, callbacks: WireCallbacks, server: ServerChoice = null): GuestSession {
  let disposed = false
  let peer: Peer | null = null
  let conn: DataConnection | null = null
  let helloSent = false

  const normalized = code.trim().toUpperCase().replace(/\s+/g, '')
  callbacks.onStatus?.('connecting')
  peer = makePeer(undefined, server)

  peer.on('open', () => {
    if (disposed || conn) return
    const link = peer!.connect(PEER_PREFIX + normalized, { reliable: true })
    conn = link
    attachConnection(link, callbacks)
    link.on('open', () => {
      if (disposed || helloSent) return
      helloSent = true
      link.send({ kind: 'hello', name, protocolVersion: PROTOCOL_VERSION } satisfies NetMessage)
      callbacks.onStatus?.('connected')
    })
    link.on('close', () => {
      if (conn === link) conn = null
      helloSent = false
    })
  })

  peer.on('error', (error) => {
    if (disposed) return
    const type = (error as { type?: string }).type
    if (type === 'peer-unavailable') {
      callbacks.onStatus?.('error')
      callbacks.onError?.('peer-unavailable')
      return
    }
    callbacks.onStatus?.('error')
    callbacks.onError?.(type ?? error.message)
  })
  peer.on('disconnected', () => { if (!disposed) peer?.reconnect() })

  return {
    role: 'guest',
    code: normalized,
    send(message) {
      if (conn && conn.open) conn.send(message)
    },
    dispose() {
      disposed = true
      callbacks.onStatus?.('closed')
      try { conn?.close() } catch { /* already gone */ }
      conn = null
      try { peer?.destroy() } catch { /* already gone */ }
      peer = null
    },
  }
}
