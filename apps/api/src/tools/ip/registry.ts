/**
 * A small registry of well-known protected marks used by the IP & Trademark
 * agent. In production this would come from a maintained trademark database;
 * here it is a fixed list so the behaviour is reproducible and testable.
 *
 * - names: brand names that are always protected in print
 * - ambiguousNames: brand names that are also everyday words ("apple", "puma");
 *   these need context, so they are flagged for a person to decide
 * - slogans: protected taglines
 * - logoDescriptions: plain-language descriptions of the logo, matched against
 *   what the vision model sees (no logo images are stored in this repo)
 */
export interface ProtectedMark {
  id: string;
  owner: string;
  names: string[];
  ambiguousNames: string[];
  slogans: string[];
  logoDescriptions: string[];
}

export const PROTECTED_MARKS: readonly ProtectedMark[] = [
  {
    id: 'nike',
    owner: 'Nike, Inc.',
    names: ['nike'],
    ambiguousNames: [],
    slogans: ['just do it'],
    logoDescriptions: ['swoosh', 'curved check mark tick logo'],
  },
  {
    id: 'adidas',
    owner: 'adidas AG',
    names: ['adidas'],
    ambiguousNames: [],
    slogans: ['impossible is nothing'],
    logoDescriptions: ['three parallel diagonal stripes', 'trefoil leaf logo with three stripes'],
  },
  {
    id: 'puma',
    owner: 'PUMA SE',
    names: [],
    ambiguousNames: ['puma'],
    slogans: ['forever faster'],
    logoDescriptions: ['leaping cat silhouette'],
  },
  {
    id: 'apple',
    owner: 'Apple Inc.',
    names: [],
    ambiguousNames: ['apple'],
    slogans: ['think different'],
    logoDescriptions: ['apple silhouette with a bite taken out'],
  },
  {
    id: 'coca-cola',
    owner: 'The Coca-Cola Company',
    names: ['coca cola', 'cocacola'],
    ambiguousNames: ['coke'],
    slogans: ['taste the feeling'],
    logoDescriptions: ['red disc with white flowing script lettering', 'contour glass bottle'],
  },
  {
    id: 'mcdonalds',
    owner: "McDonald's Corporation",
    names: ['mcdonalds'],
    ambiguousNames: [],
    slogans: ['im lovin it'],
    logoDescriptions: ['golden arches forming the letter m'],
  },
  {
    id: 'disney',
    owner: 'The Walt Disney Company',
    names: ['disney'],
    ambiguousNames: [],
    slogans: [],
    logoDescriptions: ['three circles forming mouse ears silhouette', 'fairytale castle with turrets'],
  },
  {
    id: 'starbucks',
    owner: 'Starbucks Corporation',
    names: ['starbucks'],
    ambiguousNames: [],
    slogans: [],
    logoDescriptions: ['twin-tailed siren in a green circle'],
  },
  {
    id: 'ferrari',
    owner: 'Ferrari S.p.A.',
    names: ['ferrari'],
    ambiguousNames: [],
    slogans: [],
    logoDescriptions: ['black prancing horse on a yellow shield'],
  },
  {
    id: 'shell',
    owner: 'Shell plc',
    names: [],
    ambiguousNames: ['shell'],
    slogans: [],
    logoDescriptions: ['yellow and red scallop shell'],
  },
];
