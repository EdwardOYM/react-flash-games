// Lobby view for Pokemon Pack Battle (04) - host/guest forms
import type { TranslationKey } from '../../assets/languages'
import type { PackBattlePeerStatus } from './net/peer'
import { PACK_BATTLE_LIMITS } from './net/protocol'

interface LobbyViewProps {
  role: 'host' | 'guest'
  status: PackBattlePeerStatus
  name: string
  codeInput: string
  packs: number
  server: string
  hostName: string | null
  guestName: string | null
  onNameChange: (value: string) => void
  onCodeChange: (value: string) => void
  onServerChange: (value: string) => void
  onPacksChange: (delta: number) => void
  onCreate: () => void
  onJoin: () => void
  onLeave: () => void
  onStartMatch: () => void
  t: (key: TranslationKey) => string
}

export function LobbyView(p: LobbyViewProps) {
  const { role, status, name, codeInput, packs, server, hostName, guestName, onNameChange, onCodeChange, onServerChange, onPacksChange, onCreate, onJoin, onLeave, onStartMatch, t } = p
  const isHost = role === 'host'
  const connected = status === 'connected'
  const canStart = connected && (isHost ? guestName : hostName)
  const canSubmit = isHost ? name.trim() : name.trim() && codeInput.trim()
  const sc = status === 'connected' ? 'ppb-status-connected' : status === 'error' ? 'ppb-status-error' : ''

  const statusText = (): string => {
    if (status === 'waiting') return isHost ? t('packBattle.statusWaiting') : (hostName ? t('packBattle.waitingOpponent') : t('packBattle.statusWaiting'))
    if (status === 'connecting') return t('packBattle.statusConnecting')
    if (status === 'connected') return (isHost ? guestName : hostName) ? t('packBattle.statusConnected') : t('packBattle.statusWaiting')
    return t('packBattle.statusError')
  }

  return (
    <div className="ppb-lobby">
      <div className="ppb-lobby-tabs">
        <button type="button" className={isHost ? 'ppb-primary' : ''}>{t('packBattle.createLobby')}</button>
        <button type="button" className={!isHost ? 'ppb-primary' : ''}>{t('packBattle.joinLobby')}</button>
      </div>
      {isHost ? (
        <div className="ppb-lobby-form">
          <div className="ppb-field"><label className="ppb-field-label" htmlFor="ppb-name">{t('packBattle.displayName')}</label>
            <input id="ppb-name" type="text" className="ppb-input" placeholder={t('packBattle.namePlaceholder')} value={name} onChange={e => onNameChange(e.target.value)} />
          </div>
          <div className="ppb-field"><label className="ppb-field-label" htmlFor="ppb-packs">{t('packBattle.packsLabel')}</label>
            <div className="ppb-packs-control">
              <button type="button" className="ppb-control-button" onClick={() => onPacksChange(-1)} disabled={packs <= PACK_BATTLE_LIMITS.minPacks} aria-label={t('packBattle.decrease')}>−</button>
              <span className="ppb-packs-value">{packs}</span>
              <button type="button" className="ppb-control-button" onClick={() => onPacksChange(1)} disabled={packs >= PACK_BATTLE_LIMITS.maxPacks} aria-label={t('packBattle.increase')}>+</button>
            </div>
          </div>
          <div className="ppb-field"><label className="ppb-field-label" htmlFor="ppb-server">{t('packBattle.optionalServer')}</label>
            <input id="ppb-server" type="text" className="ppb-input" placeholder={t('packBattle.serverPlaceholder')} value={server} onChange={e => onServerChange(e.target.value)} />
          </div>
          <div className="ppb-status"><span className="ppb-status-label">{t('packBattle.status')}:</span><span className={`ppb-status-value ${sc}`}>{statusText()}</span></div>
          {canStart ? <button className="ppb-primary" type="button" onClick={onStartMatch}>{t('packBattle.startBattle')}</button> :
            <button type="button" onClick={onCreate} disabled={!canSubmit}>{status === 'waiting' ? t('packBattle.createLobby') : t('packBattle.statusConnecting')}</button>}
          {isHost && <button type="button" onClick={onLeave} className="ppb-leave-button">{t('packBattle.leave')}</button>}
        </div>
      ) : (
        <div className="ppb-lobby-form">
          <div className="ppb-field"><label className="ppb-field-label" htmlFor="ppb-code">{t('packBattle.lobbyCode')}</label>
            <input id="ppb-code" type="text" className="ppb-input" placeholder={t('packBattle.codePlaceholder')} value={codeInput} onChange={e => onCodeChange(e.target.value)} maxLength={6} />
          </div>
          <div className="ppb-field"><label className="ppb-field-label" htmlFor="ppb-name-guest">{t('packBattle.displayName')}</label>
            <input id="ppb-name-guest" type="text" className="ppb-input" placeholder={t('packBattle.namePlaceholder')} value={name} onChange={e => onNameChange(e.target.value)} />
          </div>
          <div className="ppb-field"><label className="ppb-field-label" htmlFor="ppb-server-guest">{t('packBattle.optionalServer')}</label>
            <input id="ppb-server-guest" type="text" className="ppb-input" placeholder={t('packBattle.serverPlaceholder')} value={server} onChange={e => onServerChange(e.target.value)} />
          </div>
          <div className="ppb-status"><span className="ppb-status-label">{t('packBattle.status')}:</span><span className={`ppb-status-value ${sc}`}>{statusText()}</span></div>
          {canStart ? <button className="ppb-primary" type="button" onClick={onStartMatch}>{t('packBattle.startBattle')}</button> :
            <button type="button" onClick={onJoin} disabled={!canSubmit}>{status === 'waiting' ? t('packBattle.join') : t('packBattle.statusConnecting')}</button>}
        </div>
      )}
      {connected && <div className="ppb-opponent-info"><span className="ppb-opponent-label">{t('packBattle.opponent')}:</span><span className="ppb-opponent-name">{isHost ? guestName : hostName}</span></div>}
    </div>
  )
}
