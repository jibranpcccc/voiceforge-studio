/**
 * Exact EnTokenizer & punctuation normalizer for Chatterbox ONNX
 * (`onnx-community/chatterbox-ONNX`, commit `3cab09af388d3f02bba43443fce88c1f4525ac43`).
 *
 * Implements the exact Hugging Face `tokenizers` BPE pipeline from `tokenizer.json`:
 * - Non-normalized `added_tokens` matching (including `[START]`, `[STOP]`, `[EXAGGERATION]`,
 *   `[START_SPEECH]`, `[STOP_SPEECH]`, and paralinguistic tags `[laughter]`, `[sigh]`, etc.)
 * - Normalizer: `Replace` regex `\s+` -> `" "`
 * - Pre-tokenizer: `null` (single-sequence character-level BPE over the normalized segment)
 * - Model: BPE (`vocab` size 704, `merges` 265, `unk_token: "[UNK]"`, `fuse_unk: false`)
 * - Post-processor: `[EXAGGERATION] (6563)`, `[START] (255)`, sequence, `[STOP] (0)`,
 *   `[START_SPEECH] (6561)`, `[START_SPEECH] (6561)`
 */

export const START_TEXT_TOKEN = 255;
export const STOP_TEXT_TOKEN = 0;
export const UNK_TOKEN_ID = 1;
export const START_SPEECH_TOKEN = 6561;
export const STOP_SPEECH_TOKEN = 6562;
export const EXAGGERATION_TOKEN = 6563;
export const SILENCE_TOKEN = 4299;

export const MAX_TOKEN_BUDGET = 1024;
export const TOKENS_PER_CHAR = 2.4;
export const TOKEN_BUDGET_OFFSET = 20;

export interface TokenizerJsonSpec {
  added_tokens: Array<{
    id: number;
    content: string;
    special?: boolean;
    normalized?: boolean;
  }>;
  model: {
    unk_token?: string;
    vocab: Record<string, number>;
    merges: string[];
  };
}

const ADDED_TOKENS: ReadonlyArray<readonly [string, number]> = [
  ['[STOP]', 0],
  ['[UNK]', 1],
  ['[START]', 255],
  ['[UH]', 604],
  ['[UM]', 605],
  ['[giggle]', 606],
  ['[laughter]', 607],
  ['[guffaw]', 608],
  ['[inhale]', 609],
  ['[exhale]', 610],
  ['[sigh]', 611],
  ['[cry]', 612],
  ['[bark]', 613],
  ['[howl]', 614],
  ['[meow]', 615],
  ['[singing]', 616],
  ['[music]', 617],
  ['[whistle]', 618],
  ['[humming]', 619],
  ['[gasp]', 620],
  ['[groan]', 621],
  ['[whisper]', 622],
  ['[mumble]', 623],
  ['[sniff]', 624],
  ['[sneeze]', 625],
  ['[cough]', 626],
  ['[snore]', 627],
  ['[chew]', 628],
  ['[sip]', 629],
  ['[clear_throat]', 630],
  ['[kiss]', 631],
  ['[shhh]', 632],
  ['[gibberish]', 633],
  ['[fr]', 634],
  ['[es]', 635],
  ['[de]', 636],
  ['[it]', 637],
  ['[ipa]', 638],
  ['[end_of_label]', 639],
  ['[PLACEHOLDER55]', 695],
  ['[PLACEHOLDER56]', 696],
  ['[PLACEHOLDER57]', 697],
  ['[PLACEHOLDER58]', 698],
  ['[PLACEHOLDER59]', 699],
  ['[PLACEHOLDER60]', 700],
  ['[PLACEHOLDER61]', 701],
  ['[PLACEHOLDER62]', 702],
  ['[PLACEHOLDER63]', 703],
  ['[START_SPEECH]', 6561],
  ['[STOP_SPEECH]', 6562],
  ['[EXAGGERATION]', 6563],
];

const DEFAULT_VOCAB: Record<string, number> = {
  '0': 263,
  '1': 264,
  '2': 265,
  '3': 266,
  '4': 267,
  '5': 268,
  '6': 269,
  '7': 270,
  '8': 271,
  '9': 272,
  '[STOP]': 0,
  '[UNK]': 1,
  ' ': 2,
  '!': 3,
  "'": 4,
  '(': 5,
  ')': 6,
  ',': 7,
  '-': 8,
  '.': 9,
  '/': 10,
  ':': 11,
  ';': 12,
  '?': 13,
  a: 14,
  b: 15,
  c: 16,
  d: 17,
  e: 18,
  f: 19,
  g: 20,
  h: 21,
  i: 22,
  j: 23,
  k: 24,
  l: 25,
  m: 26,
  n: 27,
  o: 28,
  p: 29,
  q: 30,
  r: 31,
  s: 32,
  t: 33,
  u: 34,
  v: 35,
  w: 36,
  x: 37,
  y: 38,
  z: 39,
  th: 40,
  in: 41,
  the: 42,
  an: 43,
  er: 44,
  ou: 45,
  re: 46,
  on: 47,
  at: 48,
  ed: 49,
  en: 50,
  to: 51,
  ing: 52,
  and: 53,
  is: 54,
  as: 55,
  al: 56,
  or: 57,
  of: 58,
  ar: 59,
  it: 60,
  es: 61,
  he: 62,
  st: 63,
  le: 64,
  om: 65,
  se: 66,
  be: 67,
  ad: 68,
  ow: 69,
  ly: 70,
  ch: 71,
  wh: 72,
  that: 73,
  you: 74,
  li: 75,
  ve: 76,
  ac: 77,
  ti: 78,
  ld: 79,
  me: 80,
  was: 81,
  gh: 82,
  id: 83,
  ll: 84,
  wi: 85,
  ent: 86,
  for: 87,
  ay: 88,
  ro: 89,
  ver: 90,
  ic: 91,
  her: 92,
  ke: 93,
  his: 94,
  no: 95,
  ut: 96,
  un: 97,
  ir: 98,
  lo: 99,
  we: 100,
  ri: 101,
  ha: 102,
  with: 103,
  ght: 104,
  out: 105,
  im: 106,
  ion: 107,
  all: 108,
  ab: 109,
  one: 110,
  ne: 111,
  ge: 112,
  ould: 113,
  ter: 114,
  mo: 115,
  had: 116,
  ce: 117,
  she: 118,
  go: 119,
  sh: 120,
  ur: 121,
  am: 122,
  so: 123,
  pe: 124,
  my: 125,
  de: 126,
  are: 127,
  but: 128,
  ome: 129,
  fr: 130,
  ther: 131,
  fe: 132,
  su: 133,
  do: 134,
  con: 135,
  te: 136,
  ain: 137,
  ere: 138,
  po: 139,
  if: 140,
  they: 141,
  us: 142,
  ag: 143,
  tr: 144,
  now: 145,
  oun: 146,
  this: 147,
  have: 148,
  not: 149,
  sa: 150,
  il: 151,
  up: 152,
  thing: 153,
  from: 154,
  ap: 155,
  him: 156,
  ack: 157,
  ation: 158,
  ant: 159,
  our: 160,
  op: 161,
  like: 162,
  ust: 163,
  ess: 164,
  bo: 165,
  ok: 166,
  ul: 167,
  ind: 168,
  ex: 169,
  com: 170,
  some: 171,
  there: 172,
  ers: 173,
  co: 174,
  res: 175,
  man: 176,
  ard: 177,
  pl: 178,
  wor: 179,
  way: 180,
  tion: 181,
  fo: 182,
  ca: 183,
  were: 184,
  by: 185,
  ate: 186,
  pro: 187,
  ted: 188,
  ound: 189,
  own: 190,
  would: 191,
  ts: 192,
  what: 193,
  qu: 194,
  ally: 195,
  ight: 196,
  ck: 197,
  gr: 198,
  when: 199,
  ven: 200,
  can: 201,
  ough: 202,
  ine: 203,
  end: 204,
  per: 205,
  ous: 206,
  od: 207,
  ide: 208,
  know: 209,
  ty: 210,
  very: 211,
  si: 212,
  ak: 213,
  who: 214,
  about: 215,
  ill: 216,
  them: 217,
  est: 218,
  red: 219,
  ye: 220,
  could: 221,
  ong: 222,
  your: 223,
  their: 224,
  em: 225,
  just: 226,
  other: 227,
  into: 228,
  any: 229,
  whi: 230,
  um: 231,
  tw: 232,
  ast: 233,
  der: 234,
  did: 235,
  ie: 236,
  been: 237,
  ace: 238,
  ink: 239,
  ity: 240,
  back: 241,
  ting: 242,
  br: 243,
  more: 244,
  ake: 245,
  pp: 246,
  then: 247,
  sp: 248,
  el: 249,
  use: 250,
  bl: 251,
  said: 252,
  over: 253,
  get: 254,
  '[START]': 255,
  '"': 256,
  '#': 257,
  $: 258,
  '%': 259,
  '&': 260,
  '*': 261,
  '+': 262,
  '<': 273,
  '=': 274,
  '>': 275,
  '@': 276,
  A: 277,
  B: 278,
  C: 279,
  D: 280,
  E: 281,
  F: 282,
  G: 283,
  H: 284,
  I: 285,
  J: 286,
  K: 287,
  L: 288,
  M: 289,
  N: 290,
  O: 291,
  P: 292,
  Q: 293,
  R: 294,
  S: 295,
  T: 296,
  U: 297,
  V: 298,
  W: 299,
  X: 300,
  Y: 301,
  Z: 302,
  '[': 303,
  '\\': 304,
  ']': 305,
  '^': 306,
  _: 307,
  '`': 308,
  '{': 309,
  '|': 310,
  '}': 311,
  '~': 312,
  '\u2010': 313,
  '\u2011': 314,
  '\u2012': 315,
  '\u2013': 316,
  '\u2014': 317,
  '\u2015': 318,
  '\u2016': 319,
  '\u2017': 320,
  '\u2018': 321,
  '\u2019': 322,
  '\u201a': 323,
  '\u201b': 324,
  '\u201c': 325,
  '\u201d': 326,
  '\u201e': 327,
  '\u201f': 328,
  '\u00a0': 329,
  '\u00a1': 330,
  '\u00a2': 331,
  '\u00a3': 332,
  '\u00a4': 333,
  '\u00a5': 334,
  '\u00a6': 335,
  '\u00a7': 336,
  '\u00a8': 337,
  '\u00a9': 338,
  '\u00aa': 339,
  '\u00ab': 340,
  '\u00ac': 341,
  '\u00ad': 342,
  '\u00ae': 343,
  '\u00af': 344,
  '\u00b0': 345,
  '\u00b1': 346,
  '\u00b2': 347,
  '\u00b3': 348,
  '\u00b4': 349,
  '\u00b5': 350,
  '\u00b6': 351,
  '\u00b7': 352,
  '\u00b8': 353,
  '\u00b9': 354,
  '\u00ba': 355,
  '\u00bb': 356,
  '\u00bc': 357,
  '\u00bd': 358,
  '\u00be': 359,
  '\u00bf': 360,
  '\u00c0': 361,
  '\u00c1': 362,
  '\u00c2': 363,
  '\u00c3': 364,
  '\u00c4': 365,
  '\u00c5': 366,
  '\u00c6': 367,
  '\u00c7': 368,
  '\u00c8': 369,
  '\u00c9': 370,
  '\u00ca': 371,
  '\u00cb': 372,
  '\u00cc': 373,
  '\u00cd': 374,
  '\u00ce': 375,
  '\u00cf': 376,
  '\u00d0': 377,
  '\u00d1': 378,
  '\u00d2': 379,
  '\u00d3': 380,
  '\u00d4': 381,
  '\u00d5': 382,
  '\u00d6': 383,
  '\u00d7': 384,
  '\u00d8': 385,
  '\u00d9': 386,
  '\u00da': 387,
  '\u00db': 388,
  '\u00dc': 389,
  '\u00dd': 390,
  '\u00de': 391,
  '\u00df': 392,
  '\u00e0': 393,
  '\u00e1': 394,
  '\u00e2': 395,
  '\u00e3': 396,
  '\u00e4': 397,
  '\u00e5': 398,
  '\u00e6': 399,
  '\u00e7': 400,
  '\u00e8': 401,
  '\u00e9': 402,
  '\u00ea': 403,
  '\u00eb': 404,
  '\u00ec': 405,
  '\u00ed': 406,
  '\u00ee': 407,
  '\u00ef': 408,
  '\u00f0': 409,
  '\u00f1': 410,
  '\u00f2': 411,
  '\u00f3': 412,
  '\u00f4': 413,
  '\u00f5': 414,
  '\u00f6': 415,
  '\u00f7': 416,
  '\u00f8': 417,
  '\u00f9': 418,
  '\u00fa': 419,
  '\u00fb': 420,
  '\u00fc': 421,
  '\u00fd': 422,
  '\u00fe': 423,
  '\u00ff': 424,
  '\u0250': 425,
  '\u0251': 426,
  '\u0252': 427,
  '\u0253': 428,
  '\u0254': 429,
  '\u0255': 430,
  '\u0256': 431,
  '\u0257': 432,
  '\u0258': 433,
  '\u0259': 434,
  '\u025a': 435,
  '\u025b': 436,
  '\u025c': 437,
  '\u025d': 438,
  '\u025e': 439,
  '\u025f': 440,
  '\u0260': 441,
  '\u0261': 442,
  '\u0262': 443,
  '\u0263': 444,
  '\u0264': 445,
  '\u0265': 446,
  '\u0266': 447,
  '\u0267': 448,
  '\u0268': 449,
  '\u0269': 450,
  '\u026a': 451,
  '\u026b': 452,
  '\u026c': 453,
  '\u026d': 454,
  '\u026e': 455,
  '\u026f': 456,
  '\u0270': 457,
  '\u0271': 458,
  '\u0272': 459,
  '\u0273': 460,
  '\u0274': 461,
  '\u0275': 462,
  '\u0276': 463,
  '\u0277': 464,
  '\u0278': 465,
  '\u0279': 466,
  '\u027a': 467,
  '\u027b': 468,
  '\u027c': 469,
  '\u027d': 470,
  '\u027e': 471,
  '\u027f': 472,
  '\u0280': 473,
  '\u0281': 474,
  '\u0282': 475,
  '\u0283': 476,
  '\u0284': 477,
  '\u0285': 478,
  '\u0286': 479,
  '\u0287': 480,
  '\u0288': 481,
  '\u0289': 482,
  '\u028a': 483,
  '\u028b': 484,
  '\u028c': 485,
  '\u028d': 486,
  '\u028e': 487,
  '\u028f': 488,
  '\u0290': 489,
  '\u0291': 490,
  '\u0292': 491,
  '\u0293': 492,
  '\u0294': 493,
  '\u0295': 494,
  '\u0296': 495,
  '\u0297': 496,
  '\u0298': 497,
  '\u0299': 498,
  '\u029a': 499,
  '\u029b': 500,
  '\u029c': 501,
  '\u029d': 502,
  '\u029e': 503,
  '\u029f': 504,
  '\u02a0': 505,
  '\u02a1': 506,
  '\u02a2': 507,
  '\u02a3': 508,
  '\u02a4': 509,
  '\u02a5': 510,
  '\u02a6': 511,
  '\u02a7': 512,
  '\u02a8': 513,
  '\u02a9': 514,
  '\u02aa': 515,
  '\u02ab': 516,
  '\u02ac': 517,
  '\u02ad': 518,
  '\u02ae': 519,
  '\u02af': 520,
  '\u02b0': 521,
  '\u02b1': 522,
  '\u02b2': 523,
  '\u02b3': 524,
  '\u02b4': 525,
  '\u02b5': 526,
  '\u02b6': 527,
  '\u02b7': 528,
  '\u02b8': 529,
  '\u02b9': 530,
  '\u02ba': 531,
  '\u02bb': 532,
  '\u02bc': 533,
  '\u02bd': 534,
  '\u02be': 535,
  '\u02bf': 536,
  '\u02c0': 537,
  '\u02c1': 538,
  '\u02c2': 539,
  '\u02c3': 540,
  '\u02c4': 541,
  '\u02c5': 542,
  '\u02c6': 543,
  '\u02c7': 544,
  '\u02c8': 545,
  '\u02c9': 546,
  '\u02ca': 547,
  '\u02cb': 548,
  '\u02cc': 549,
  '\u02cd': 550,
  '\u02ce': 551,
  '\u02cf': 552,
  '\u02d0': 553,
  '\u02d1': 554,
  '\u02d2': 555,
  '\u02d3': 556,
  '\u02d4': 557,
  '\u02d5': 558,
  '\u02d6': 559,
  '\u02d7': 560,
  '\u02d8': 561,
  '\u02d9': 562,
  '\u02da': 563,
  '\u02db': 564,
  '\u02dc': 565,
  '\u02dd': 566,
  '\u02de': 567,
  '\u02df': 568,
  '\u02e0': 569,
  '\u02e1': 570,
  '\u02e2': 571,
  '\u02e3': 572,
  '\u02e4': 573,
  '\u02e5': 574,
  '\u02e6': 575,
  '\u02e7': 576,
  '\u02e8': 577,
  '\u02e9': 578,
  '\u02ea': 579,
  '\u02eb': 580,
  '\u02ec': 581,
  '\u02ed': 582,
  '\u02ee': 583,
  '\u02ef': 584,
  '\u02f0': 585,
  '\u02f1': 586,
  '\u02f2': 587,
  '\u02f3': 588,
  '\u02f4': 589,
  '\u02f5': 590,
  '\u02f6': 591,
  '\u02f7': 592,
  '\u02f8': 593,
  '\u02f9': 594,
  '\u02fa': 595,
  '\u02fb': 596,
  '\u02fc': 597,
  '\u02fd': 598,
  '\u02fe': 599,
  '\u02ff': 600,
  '\u0101': 601,
  '\u014d': 602,
  '\u2026': 603,
  '[UH]': 604,
  '[UM]': 605,
  '[giggle]': 606,
  '[laughter]': 607,
  '[guffaw]': 608,
  '[inhale]': 609,
  '[exhale]': 610,
  '[sigh]': 611,
  '[cry]': 612,
  '[bark]': 613,
  '[howl]': 614,
  '[meow]': 615,
  '[singing]': 616,
  '[music]': 617,
  '[whistle]': 618,
  '[humming]': 619,
  '[gasp]': 620,
  '[groan]': 621,
  '[whisper]': 622,
  '[mumble]': 623,
  '[sniff]': 624,
  '[sneeze]': 625,
  '[cough]': 626,
  '[snore]': 627,
  '[chew]': 628,
  '[sip]': 629,
  '[clear_throat]': 630,
  '[kiss]': 631,
  '[shhh]': 632,
  '[gibberish]': 633,
  '[fr]': 634,
  '[es]': 635,
  '[de]': 636,
  '[it]': 637,
  '[ipa]': 638,
  '[end_of_label]': 639,
  '\u014b': 640,
  '\u1d7b': 641,
  '\u03b8': 642,
  '\u0329': 643,
  '\u0303': 644,
  '\u0251\u02d0': 645,
  'i\u02d0': 646,
  'u\u02d0': 647,
  '\u025c\u02d0': 648,
  '\u0254\u02d0': 649,
  'o\u02d0': 650,
  'e\u026a': 651,
  'o\u028a': 652,
  'a\u026a': 653,
  'a\u028a': 654,
  '\u0254\u026a': 655,
  'd\u0292': 656,
  't\u0283': 657,
  '\u026a\u014b': 658,
  '\u1d7bd': 659,
  '\u02c8i\u02d0': 660,
  '\u02cci\u02d0': 661,
  '\u02c8\u026a': 662,
  '\u02cc\u026a': 663,
  '\u02c8e\u026a': 664,
  '\u02cce\u026a': 665,
  '\u02c8\u025b': 666,
  '\u02cc\u025b': 667,
  '\u02c8\u00e6': 668,
  '\u02cc\u00e6': 669,
  '\u02c8\u0251\u02d0': 670,
  '\u02cc\u0251\u02d0': 671,
  '\u02c8\u0254\u02d0': 672,
  '\u02cc\u0254\u02d0': 673,
  'o\u02d0\u0279': 674,
  '\u02c8o\u02d0\u0279': 675,
  '\u02cco\u02d0\u0279': 676,
  '\u02c8o\u028a': 677,
  '\u02cco\u028a': 678,
  '\u02c8\u028a': 679,
  '\u02cc\u028a': 680,
  '\u02c8u\u02d0': 681,
  '\u02ccu\u02d0': 682,
  '\u02c8\u025c\u02d0': 683,
  '\u02cc\u025c\u02d0': 684,
  '\u02c8\u028c': 685,
  '\u02cc\u028c': 686,
  '\u02c8a\u026a': 687,
  '\u02cca\u026a': 688,
  '\u02c8a\u028a': 689,
  '\u02cca\u028a': 690,
  '\u02c8\u0254\u026a': 691,
  '\u02cc\u0254\u026a': 692,
  '\u02c8\u025a': 693,
  '\u02cc\u0250': 694,
  '[PLACEHOLDER55]': 695,
  '[PLACEHOLDER56]': 696,
  '[PLACEHOLDER57]': 697,
  '[PLACEHOLDER58]': 698,
  '[PLACEHOLDER59]': 699,
  '[PLACEHOLDER60]': 700,
  '[PLACEHOLDER61]': 701,
  '[PLACEHOLDER62]': 702,
  '[PLACEHOLDER63]': 703,
};

const DEFAULT_MERGES: readonly string[] = [
  't h',
  'i n',
  'th e',
  'a n',
  'e r',
  'o u',
  'r e',
  'o n',
  'a t',
  'e d',
  'e n',
  't o',
  'in g',
  'an d',
  'i s',
  'a s',
  'a l',
  'o r',
  'o f',
  'a r',
  'i t',
  'e s',
  'h e',
  's t',
  'l e',
  'o m',
  's e',
  'b e',
  'a d',
  'o w',
  'l y',
  'c h',
  'w h',
  'th at',
  'y ou',
  'l i',
  'v e',
  'a c',
  't i',
  'l d',
  'm e',
  'w as',
  'g h',
  'i d',
  'l l',
  'w i',
  'en t',
  'f or',
  'a y',
  'r o',
  'v er',
  'i c',
  'h er',
  'k e',
  'h is',
  'n o',
  'u t',
  'u n',
  'i r',
  'l o',
  'w e',
  'r i',
  'h a',
  'wi th',
  'gh t',
  'ou t',
  'i m',
  'i on',
  'al l',
  'a b',
  'on e',
  'n e',
  'g e',
  'ou ld',
  't er',
  'm o',
  'h ad',
  'c e',
  's he',
  'g o',
  's h',
  'u r',
  'a m',
  's o',
  'p e',
  'm y',
  'd e',
  'a re',
  'b ut',
  'om e',
  'f r',
  'the r',
  'f e',
  's u',
  'd o',
  'c on',
  't e',
  'a in',
  'er e',
  'p o',
  'i f',
  'the y',
  'u s',
  'a g',
  't r',
  'n ow',
  'ou n',
  'th is',
  'ha ve',
  'no t',
  's a',
  'i l',
  'u p',
  'th ing',
  'fr om',
  'a p',
  'h im',
  'ac k',
  'at ion',
  'an t',
  'ou r',
  'o p',
  'li ke',
  'u st',
  'es s',
  'b o',
  'o k',
  'u l',
  'in d',
  'e x',
  'c om',
  's ome',
  'the re',
  'er s',
  'c o',
  're s',
  'm an',
  'ar d',
  'p l',
  'w or',
  'w ay',
  'ti on',
  'f o',
  'c a',
  'w ere',
  'b y',
  'at e',
  'p ro',
  't ed',
  'oun d',
  'ow n',
  'w ould',
  't s',
  'wh at',
  'q u',
  'al ly',
  'i ght',
  'c k',
  'g r',
  'wh en',
  'v en',
  'c an',
  'ou gh',
  'in e',
  'en d',
  'p er',
  'ou s',
  'o d',
  'id e',
  'k now',
  't y',
  'ver y',
  's i',
  'a k',
  'wh o',
  'ab out',
  'i ll',
  'the m',
  'es t',
  're d',
  'y e',
  'c ould',
  'on g',
  'you r',
  'the ir',
  'e m',
  'j ust',
  'o ther',
  'in to',
  'an y',
  'wh i',
  'u m',
  't w',
  'as t',
  'd er',
  'd id',
  'i e',
  'be en',
  'ac e',
  'in k',
  'it y',
  'b ack',
  't ing',
  'b r',
  'mo re',
  'a ke',
  'p p',
  'the n',
  's p',
  'e l',
  'u se',
  'b l',
  'sa id',
  'o ver',
  'ge t',
  '\u0251 \u02d0',
  'i \u02d0',
  'u \u02d0',
  '\u025c \u02d0',
  '\u0254 \u02d0',
  'o \u02d0',
  'e \u026a',
  'o \u028a',
  'a \u026a',
  'a \u028a',
  '\u0254 \u026a',
  'd \u0292',
  't \u0283',
  '\u026a \u014b',
  '\u1d7b d',
  '\u02c8 i\u02d0',
  '\u02cc i\u02d0',
  '\u02c8 \u026a',
  '\u02cc \u026a',
  '\u02c8 e\u026a',
  '\u02cc e\u026a',
  '\u02c8 \u025b',
  '\u02cc \u025b',
  '\u02c8 \u00e6',
  '\u02cc \u00e6',
  '\u02c8 \u0251\u02d0',
  '\u02cc \u0251\u02d0',
  '\u02c8 \u0254\u02d0',
  '\u02cc \u0254\u02d0',
  'o\u02d0 \u0279',
  '\u02c8 o\u02d0\u0279',
  '\u02cc o\u02d0\u0279',
  '\u02c8 o\u028a',
  '\u02cc o\u028a',
  '\u02c8 \u028a',
  '\u02cc \u028a',
  '\u02c8 u\u02d0',
  '\u02cc u\u02d0',
  '\u02c8 \u025c\u02d0',
  '\u02cc \u025c\u02d0',
  '\u02c8 \u028c',
  '\u02cc \u028c',
  '\u02c8 a\u026a',
  '\u02cc a\u026a',
  '\u02c8 a\u028a',
  '\u02cc a\u028a',
  '\u02c8 \u0254\u026a',
  '\u02cc \u0254\u026a',
  '\u02c8 \u025a',
  '\u02cc \u0250',
];

const PUNC_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['...', ', '],
  ['\u2026', ', '],
  [':', ','],
  [' - ', ', '],
  [';', ', '],
  ['\u2014', '-'],
  ['\u2013', '-'],
  [' ,', ','],
  ['\u201c', '"'],
  ['\u201d', '"'],
  ['\u2018', "'"],
  ['\u2019', "'"],
];

const SENTENCE_ENDERS = new Set(['.', '!', '?', '-', ',']);

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Upstream Chatterbox `punc_norm` punctuation and sentence-boundary cleanup.
 */
export function normalizeChatterboxText(rawText: string): string {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return 'You need to add some text for me to talk.';
  }

  let text = trimmed;
  if (text[0] !== text[0].toUpperCase() && text[0] === text[0].toLowerCase()) {
    text = text[0].toUpperCase() + text.slice(1);
  }

  // Collapse all whitespace runs into single spaces.
  text = text.split(/\s+/).join(' ');

  for (const [oldSeq, newSeq] of PUNC_REPLACEMENTS) {
    text = text.replaceAll(oldSeq, newSeq);
  }

  text = text.replace(/ +$/, '');
  const lastChar = text.charAt(text.length - 1);
  if (!SENTENCE_ENDERS.has(lastChar)) {
    text += '.';
  }

  return text;
}

/**
 * Compute dynamic autoregressive speech token budget:
 * `min(1024, Math.ceil(chars * 2.4 + 20))`.
 */
export function calculateTokenBudget(text: string): number {
  const charCount = Math.max(0, text.length);
  return Math.min(
    MAX_TOKEN_BUDGET,
    Math.ceil(charCount * TOKENS_PER_CHAR + TOKEN_BUDGET_OFFSET)
  );
}

/**
 * Compute `position_ids` matching `onnx-community/chatterbox-ONNX` and Transformers.js:
 * special speech/exaggeration tokens (`>= START_SPEECH_TOKEN`) get position `0`;
 * all preceding text tokens increment sequentially from `0`.
 */
export function computeChatterboxPositionIds(inputIds: readonly number[]): number[] {
  let position = 0;
  return inputIds.map((id) => (id >= START_SPEECH_TOKEN ? 0 : position++));
}

interface TextSegment {
  isAddedToken: boolean;
  id?: number;
  text: string;
}

/**
 * Pure TypeScript BPE tokenizer matching `onnx-community/chatterbox-ONNX/tokenizer.json`.
 */
export class EnTokenizer {
  private readonly vocab: Map<string, number>;
  private readonly idToToken: Map<number, string>;
  private readonly specialTokenIds: Set<number>;
  private readonly addedTokenMap: Map<string, number>;
  private readonly addedTokenRegex: RegExp | null;
  private readonly mergeRanks: Map<string, number>;
  private readonly unkId: number;

  constructor(spec?: TokenizerJsonSpec) {
    this.vocab = new Map<string, number>();
    this.idToToken = new Map<number, string>();
    this.specialTokenIds = new Set<number>();
    this.addedTokenMap = new Map<string, number>();
    this.mergeRanks = new Map<string, number>();

    const rawVocab = spec?.model?.vocab ?? DEFAULT_VOCAB;
    for (const [token, id] of Object.entries(rawVocab)) {
      this.vocab.set(token, id);
      this.idToToken.set(id, token);
    }

    const addedList: Array<readonly [string, number, boolean]> = spec?.added_tokens
      ? spec.added_tokens.map((item) => [item.content, item.id, Boolean(item.special)] as const)
      : ADDED_TOKENS.map(([content, id]) => [content, id, true] as const);

    for (const [content, id, isSpecial] of addedList) {
      this.addedTokenMap.set(content, id);
      if (!this.idToToken.has(id)) {
        this.idToToken.set(id, content);
      }
      if (isSpecial) {
        this.specialTokenIds.add(id);
      }
    }

    const sortedAdded = [...this.addedTokenMap.keys()].sort((a, b) => b.length - a.length);
    this.addedTokenRegex =
      sortedAdded.length > 0
        ? new RegExp(`(${sortedAdded.map(escapeRegExp).join('|')})`, 'g')
        : null;

    const merges = spec?.model?.merges ?? DEFAULT_MERGES;
    for (let rank = 0; rank < merges.length; rank += 1) {
      const spaceIdx = merges[rank].indexOf(' ');
      if (spaceIdx <= 0) continue;
      const left = merges[rank].slice(0, spaceIdx);
      const right = merges[rank].slice(spaceIdx + 1);
      this.mergeRanks.set(`${left}\0${right}`, rank);
    }

    const unkToken = spec?.model?.unk_token ?? '[UNK]';
    this.unkId = this.vocab.get(unkToken) ?? UNK_TOKEN_ID;
  }

  static fromJSON(json: string | TokenizerJsonSpec): EnTokenizer {
    const parsed = typeof json === 'string' ? (JSON.parse(json) as TokenizerJsonSpec) : json;
    return new EnTokenizer(parsed);
  }

  private splitAddedTokens(text: string): TextSegment[] {
    if (!this.addedTokenRegex || text.length === 0) {
      return text.length > 0 ? [{ isAddedToken: false, text }] : [];
    }

    const segments: TextSegment[] = [];
    this.addedTokenRegex.lastIndex = 0;
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = this.addedTokenRegex.exec(text)) !== null) {
      if (match.index > cursor) {
        segments.push({ isAddedToken: false, text: text.slice(cursor, match.index) });
      }
      const token = match[0];
      const id = this.addedTokenMap.get(token);
      if (id !== undefined) {
        segments.push({ isAddedToken: true, id, text: token });
      } else {
        segments.push({ isAddedToken: false, text: token });
      }
      cursor = match.index + token.length;
    }

    if (cursor < text.length) {
      segments.push({ isAddedToken: false, text: text.slice(cursor) });
    }

    return segments;
  }

  private bpeSegment(normalizedSegment: string): number[] {
    if (normalizedSegment.length === 0) return [];

    let pieces = Array.from(normalizedSegment);
    if (pieces.length >= 2) {
      while (pieces.length >= 2) {
        let bestRank = Infinity;
        let bestLeft = '';
        let bestRight = '';

        for (let i = 0; i < pieces.length - 1; i += 1) {
          const rank = this.mergeRanks.get(`${pieces[i]}\0${pieces[i + 1]}`);
          if (rank !== undefined && rank < bestRank) {
            bestRank = rank;
            bestLeft = pieces[i];
            bestRight = pieces[i + 1];
          }
        }

        if (!Number.isFinite(bestRank)) {
          break;
        }

        const nextPieces: string[] = [];
        for (let i = 0; i < pieces.length; i += 1) {
          if (i < pieces.length - 1 && pieces[i] === bestLeft && pieces[i + 1] === bestRight) {
            nextPieces.push(bestLeft + bestRight);
            i += 1;
          } else {
            nextPieces.push(pieces[i]);
          }
        }
        pieces = nextPieces;
      }
    }

    const ids: number[] = [];
    for (const piece of pieces) {
      ids.push(this.vocab.get(piece) ?? this.unkId);
    }
    return ids;
  }

  /**
   * Encode text into Chatterbox token IDs.
   * Matches `tokenizers.Tokenizer.from_file("tokenizer.json").encode(text).ids`
   * including the `TemplateProcessing` wrapper:
   * `[EXAGGERATION (6563), START (255), ...tokens, STOP (0), START_SPEECH (6561), START_SPEECH (6561)]`.
   */
  encode(text: string, options: { addSpecialTokens?: boolean } = {}): number[] {
    const addSpecialTokens = options.addSpecialTokens ?? true;
    const sequenceIds: number[] = [];

    for (const segment of this.splitAddedTokens(text)) {
      if (segment.isAddedToken && segment.id !== undefined) {
        sequenceIds.push(segment.id);
      } else {
        // Matches tokenizer.json normalizer: Replace(/\s+/g, " ")
        const normalized = segment.text.replace(/\s+/g, ' ');
        sequenceIds.push(...this.bpeSegment(normalized));
      }
    }

    if (!addSpecialTokens) {
      return sequenceIds;
    }

    return [
      EXAGGERATION_TOKEN,
      START_TEXT_TOKEN,
      ...sequenceIds,
      STOP_TEXT_TOKEN,
      START_SPEECH_TOKEN,
      START_SPEECH_TOKEN,
    ];
  }

  /**
   * Decode token IDs back into text using `Fuse` semantics.
   */
  decode(ids: readonly number[], skipSpecialTokens = false): string {
    let out = '';
    for (const id of ids) {
      if (skipSpecialTokens && this.specialTokenIds.has(id)) {
        continue;
      }
      out += this.idToToken.get(id) ?? '';
    }
    return out;
  }
}
