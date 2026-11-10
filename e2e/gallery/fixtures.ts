// Gallery fixtures: invented names and words only, and pictures that need no
// network (an inline SVG, and a same-origin path the harness never serves).

/** A grey square photo, inline: decodes with no request. */
export const PHOTO =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'><rect width='96' height='96' fill='gray'/><circle cx='48' cy='38' r='18' fill='silver'/></svg>";

/** A picture that fails to load (no such file in the harness). */
export const BROKEN_PHOTO = '/gallery-fixture-missing.png';

export const NAME = 'Rowan Pike';
/** 25 letters: the longest display name (users_display_name_max25). */
export const LONGEST_NAME = 'Annabellemariequintessa B';
export const LONG_TEXT =
  'A long line of plain words that keeps going past the edge of the part so the truncation, wrapping and clipping all show in one place without any trick.';
export const ONE_LONG_WORD = 'Supercalifragilisticexpialidociouslyunbreakablewordwithnospaces';
export const SHORT = 'Launch week';
export const MAX_NUMBER = 120;
