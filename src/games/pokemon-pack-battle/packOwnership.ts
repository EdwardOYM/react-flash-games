// Dependency-light pack ownership shared by the ceremony reducer and pack engine.

export type BattleSeat = 'host' | 'guest' | 'both'

/**
 * Host opens even packs and guest opens odd packs. With an odd pack count the
 * final pack belongs to BOTH seats, so neither seat gets a free-pack advantage.
 */
export function seatForPack(packIndex: number, packCount: number): BattleSeat {
  if (packCount % 2 === 1 && packIndex === packCount - 1) return 'both'
  return packIndex % 2 === 0 ? 'host' : 'guest'
}
