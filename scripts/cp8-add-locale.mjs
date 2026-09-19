// Throwaway: add CP8 locale keys to en/ms/zh. Deleted after one run.
import { readFileSync, writeFileSync } from 'node:fs'

const actionKeys = {
  en: {
    battleBar: 'Actions',
    actionEndTurn: 'End turn',
    actionPause: 'Pause',
    actionResume: 'Resume',
    actionForfeit: 'Forfeit',
    actionAttack: 'Attack',
    actionRetreat: 'Retreat',
    actionPromote: 'Promote',
    actionAttachEnergy: 'Attach Energy',
    actionPlayTrainer: 'Play Trainer',
    actionEvolve: 'Evolve',
    actionSelectCard: 'Select a card',
    actionSelectTarget: 'Select a target',
    actionSelectBench: 'Select a bench Pokemon',
    actionConfirm: 'Confirm',
    actionCancel: 'Cancel',
    pausedOverlay: 'Paused',
    pausedHint: 'The host can resume or forfeit.',
    forfeitTitle: 'Forfeit match?',
    forfeitPrompt: 'Are you sure you want to forfeit this match? You will lose.',
    victoryBanner: 'Victory!',
    defeatBanner: 'Defeat…',
  },
  ms: {
    battleBar: 'Tindakan',
    actionEndTurn: 'Akhirkan giliran',
    actionPause: 'Jeda',
    actionResume: 'Sambung',
    actionForfeit: 'Menyerah',
    actionAttack: 'Serang',
    actionRetreat: 'Undur',
    actionPromote: 'Promosi',
    actionAttachEnergy: 'Lampirkan Tenaga',
    actionPlayTrainer: 'Mainkan Pelatih',
    actionEvolve: 'Berevolusi',
    actionSelectCard: 'Pilih kad',
    actionSelectTarget: 'Pilih sasaran',
    actionSelectBench: 'Pilih Pokemon panking',
    actionConfirm: 'Sahkan',
    actionCancel: 'Batal',
    pausedOverlay: 'Dijeda',
    pausedHint: 'Tuan boleh sambung atau menyerah.',
    forfeitTitle: 'Serahkan permainan?',
    forfeitPrompt: 'Adakah anda pasti ingin menyerah permainan ini? Anda akan kalah.',
    victoryBanner: 'Kemenangan!',
    defeatBanner: 'Kalangan…',
  },
  zh: {
    battleBar: '操作',
    actionEndTurn: '结束回合',
    actionPause: '暂停',
    actionResume: '继续',
    actionForfeit: '投降',
    actionAttack: '攻击',
    actionRetreat: '撤退',
    actionPromote: '上场',
    actionAttachEnergy: '附Energy',
    actionPlayTrainer: '使用训练家',
    actionEvolve: '进化',
    actionSelectCard: '选择卡片',
    actionSelectTarget: '选择目标',
    actionSelectBench: '选择贝尔登上的宝可梦',
    actionConfirm: '确认',
    actionCancel: '取消',
    pausedOverlay: '已暂停',
    pausedHint: '主机可以继续或投降。',
    forfeitTitle: '确定放弃比赛？',
    forfeitPrompt: '确定要放弃这场比赛吗？你将输掉比赛。',
    victoryBanner: '胜利！',
    defeatBanner: '失败…',
  },
}

const keyNamesExtra = {
  en: { pkmBnbConfirm: 'Confirm (Space)', pkmBnbSkip: 'Skip turn (S)' },
  ms: { pkmBnbConfirm: 'Sahkan (Space)', pkmBnbSkip: 'Langkau giliran (S)' },
  zh: { pkmBnbConfirm: '确认（空格键）', pkmBnbSkip: '跳过回合（S）' },
}

for (const locale of /** @type {const} */ (['en', 'ms', 'zh'])) {
  const path = `src/assets/languages/${locale}.json`
  const data = JSON.parse(readFileSync(path, 'utf8'))
  // keyNames
  for (const [k, v] of Object.entries(keyNamesExtra[locale])) {
    data.keyNames[k] = v
  }
  // pokemonBnb flat action keys
  for (const [k, v] of Object.entries(actionKeys[locale])) {
    data.pokemonBnb[k] = v
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
  console.log(`${locale}.json: updated`)
}
