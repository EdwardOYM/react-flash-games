// PeerJS session wrapper for 04-pokemon-pack-battle. Same lobby method as 03
// (PeerJS Cloud default, optional self-hosted server; readable peer ids).
// Lobby codes use the `pkm-pack-battle-<CODE>` prefix so battles never dial
// 03 B&B lobbies. Collision auto-retries with a fresh code; the guest
// re-dials on a bounded timer after a channel drop (hello replays settings).

import Peer from 'peerjs'
import type { DataConnection } from 'peerjs'
import { PACK_BATTLE_PROTOCOL_VERSION, isPackBattleMessage, type PackBattleMessage, type PackBattleSlot } from './protocol'

export type PackBattleServerConfig = {
  host: string
  port: number
  path: string
  secure: boolean
}

/** `null` = PeerJS Cloud (default, free, needs internet). */
export type PackBattleServerChoice = PackBattleServerConfig | null

export type PackBattlePeerStatus = 'connecting' | 'waiting' | 'connected' | 'error' | 'closed'

export type PackBattleSessionCallbacks = {
  onMessage: (message: PackBattleMessage) => void
  onPeerConnected: (slot: PackBattleSlot) => void
  onPeerDisconnected: () => void
  onStatus: (status: PackBattlePeerStatus) => void
  onError: (message: string) => void
}

export type PackBattleSessionBase = {
  code: string
  dispose: () => void
  send: (message: PackBattleMessage) => void
}

export type PackBattleHostSession = PackBattleSessionBase & { role: 'host' }
export type PackBattleGuestSession = PackBattleSessionBase & { role: 'guest' }

const PACK_BATTLE_PEER_PREFIX = 'pkm-pack-battle-'
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
const CODE_RETRY_LIMIT = 5
const REDIAL_DELAY_MS = 1200
const REDIAL_LIMIT = 12

export function randomPackBattleCode(length = CODE_LENGTH): string {
  let code = ''
  for (let index = 0; index < length; index++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return code
}

/** Parse a user-entered self-hosted server address into a server config. */
export function parsePackBattleServerAddress(input: string): PackBattleServerConfig | null {
  const trimmed = input.trim()
  if (!trimmed) return null
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

type WireCallbacks = Partial<PackBattleSessionCallbacks>

function makePackBattlePeer(id: string | undefined, server: PackBattleServerChoice): Peer {
  const peerId = id ?? randomPackBattleCode(16)
  if (!server) return new Peer(peerId)
  return new Peer(peerId, {
    host: server.host,
    port: server.port,
    path: server.path,
    secure: server.secure,
  })
}

function attachPackBattleConnection(conn: DataConnection, callbacks: WireCallbacks) {
  conn.on('data', (data) => {
    if (isPackBattleMessage(data)) {
      callbacks.onMessage?.(data)
      return
    }
    const candidate = data as { kind?: unknown } | null | undefined
    if (candidate && typeof candidate === 'object') {
      if (candidate.kind === 'hello' || candidate.kind === 'hello-ack') {
        const peerMsg = data as { protocolVersion?: unknown } | null
        if (peerMsg && peerMsg.protocolVersion !== PACK_BATTLE_PROTOCOL_VERSION) {
          callbacks.onError?.('version')
        }
        return
      }
    }
  })
  conn.on('close', () => callbacks.onPeerDisconnected?.())
  conn.on('error', (error) => callbacks.onError?.(String(error)))
}

/** Host a lobby and accept one guest. Sends `hello-ack` on channel open. */
export function createPackBattleHost(
  name: string,
  _settings: { set: string; packs: number },
  callbacks: WireCallbacks,
  server: PackBattleServerChoice = null,
): PackBattleHostSession {
  let disposed = false
  let peer: Peer | null = null
  let conn: DataConnection | null = null
  let pendingCode = randomPackBattleCode()
  let attempts = 0
  callbacks.onStatus?.('connecting')

  const cleanup = () => {
    try { conn?.close() } catch { /* already gone */ }
    conn = null
    try { peer?.destroy() } catch { /* already gone */ }
    peer = null
  }

  const register = (code: string) => {
    if (disposed) return
    peer = makePackBattlePeer(PACK_BATTLE_PEER_PREFIX + code, server)
    peer.on('open', () => {
      if (disposed) return
      callbacks.onStatus?.('waiting')
    })
    peer.on('connection', (link) => {
      if (disposed || conn) {
        try { link.close() } catch { /* already gone */ }
        return
      }
      conn = link
      attachPackBattleConnection(link, callbacks)
      link.on('open', () => {
        if (disposed) return
        link.send({ kind: 'hello-ack', name, protocolVersion: PACK_BATTLE_PROTOCOL_VERSION } satisfies PackBattleMessage)
        callbacks.onPeerConnected?.('guest')
        callbacks.onStatus?.('connected')
      })
      link.on('close', () => {
        if (conn === link) conn = null
      })
    })
    peer.on('error', (error) => {
      if (disposed) return
      const type = (error as { type?: string }).type
      if (type === 'unavailable-id' && attempts < CODE_RETRY_LIMIT) {
        attempts += 1
        pendingCode = randomPackBattleCode()
        try { peer?.destroy() } catch { /* already gone */ }
        register(pendingCode)
        return
      }
      callbacks.onStatus?.('error')
      callbacks.onError?.(type ?? error.message)
    })
    peer.on('disconnected', () => { if (!disposed) peer?.reconnect() })
  }

  register(pendingCode)

  return {
    role: 'host',
    get code() {
      const registered = peer?.id
      return registered && registered.startsWith(PACK_BATTLE_PEER_PREFIX)
        ? registered.slice(PACK_BATTLE_PEER_PREFIX.length)
        : pendingCode
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
export function joinPackBattleHost(
  code: string,
  name: string,
  callbacks: WireCallbacks,
  server: PackBattleServerChoice = null,
): PackBattleGuestSession {
  let disposed = false
  let peer: Peer | null = null
  let conn: DataConnection | null = null
  let helloSent = false
  let redialTimer: ReturnType<typeof setTimeout> | null = null
  let redialAttempts = 0

  const normalized = code.trim().toUpperCase().replace(/\s+/g, '')
  callbacks.onStatus?.('connecting')
  peer = makePackBattlePeer(undefined, server)

  const scheduleRedial = () => {
    if (disposed || redialTimer !== null || redialAttempts >= REDIAL_LIMIT) return
    redialTimer = setTimeout(() => {
      redialTimer = null
      dial()
    }, REDIAL_DELAY_MS)
  }

  const dial = () => {
    if (disposed || conn || !peer) return
    let link: DataConnection
    try {
      link = peer.connect(PACK_BATTLE_PEER_PREFIX + normalized, { reliable: true })
    } catch {
      return
    }
    redialAttempts += 1
    conn = link
    attachPackBattleConnection(link, callbacks)
    link.on('open', () => {
      if (disposed || helloSent) return
      helloSent = true
      redialAttempts = 0
      link.send({ kind: 'hello', name, protocolVersion: PACK_BATTLE_PROTOCOL_VERSION } satisfies PackBattleMessage)
      callbacks.onStatus?.('connected')
    })
    link.on('close', () => {
      if (conn === link) conn = null
      helloSent = false
      callbacks.onStatus?.('waiting')
      scheduleRedial()
    })
  }

  peer.on('open', () => {
    dial()
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
      if (redialTimer !== null) {
        clearTimeout(redialTimer)
        redialTimer = null
      }
      callbacks.onStatus?.('closed')
      try { conn?.close() } catch { /* already gone */ }
      conn = null
      try { peer?.destroy() } catch { /* already gone */ }
      peer = null
    },
  }
}
