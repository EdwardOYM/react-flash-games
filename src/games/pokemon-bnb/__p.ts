import { listSets, setCards } from './sets'
import { parseAttackEffects } from './game-core'
const all = listSets().flatMap((s) => setCards(s))
for (const n of ['166', '176', '178']) {
  const c: any = all.find((x) => x.number === n)
  c.attacks.forEach((a: any, i: number) => {
    console.log(`${n}#${i} ${a.name}`)
    console.log(`   TEXT: ${a.text}`)
    console.log(`   -> ${JSON.stringify(parseAttackEffects(a.text).map((e) => e.kind))}`)
  })
}
