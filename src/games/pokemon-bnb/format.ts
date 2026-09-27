/**
 * Fill `{name}` style placeholders in a translated template, matching the Tron
 * game's copy handling. An unmatched placeholder is left visible as `{name}`
 * rather than blanked, so a missing parameter is obvious instead of silent.
 *
 * This lives in its own module (not in `PokemonBnbGame.tsx`) so co-located
 * components can fill placeholders too: importing it from the game component
 * would be a circular import, and re-declaring it per component is exactly the
 * duplication the house rules forbid.
 */
export function substituteParams(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`)
}

/** A template built from a counter count, choosing the singular or plural key. */
export function countLabel(
  count: number,
  one: string,
  many: string,
  params: Record<string, string> = { count: String(count) },
): string {
  return substituteParams(count === 1 ? one : many, params)
}
