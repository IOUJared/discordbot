export const SEARCH_CONTRACT_CASES = [
  {
    rawPath: "raw/innertube-ordinal-malformed-valid.json",
    fixturePath: "fixtures/responses/search-ordinal.json",
    rawSlots: 6,
    rawSlotIds: [7, "valid-ordinal-1", "outside-window-5"],
    excludedId: "outside-window-5",
    results: [
      ["valid-ordinal-1", "Ordinal Song", "Ordinal Artist", 62_000, 0.9],
      ["valid-ordinal-2", "Second", "Artist", 120_000, 0.8],
      ["valid-ordinal-3", "Third", "Artist", 180_000, 0.7],
      ["valid-ordinal-4", "Fourth", "Artist", 240_000, 0.6],
    ],
  },
  {
    rawPath: "raw/innertube-padding.json",
    fixturePath: "fixtures/responses/search-padding.json",
    rawSlots: 6,
    rawSlotIds: ["padded-ordinal-0", "blank-after-trim-1", "outside-padding-window-5"],
    excludedId: "outside-padding-window-5",
    results: [
      ["padded-ordinal-0", "Padded Title", "Padded Artist", 62_000, 1],
      ["padded-ordinal-2", "Second Title", "Second Artist", 123_000, 0.8],
    ],
  },
]
