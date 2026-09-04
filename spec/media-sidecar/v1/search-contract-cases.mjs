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
  {
    rawPath: "raw/innertube-insertion-order.json",
    fixturePath: "fixtures/responses/search-insertion-order.json",
    rawKeys: ["zFirst", "aSecond"],
    excludedId: "missing-result",
    results: [
      ["z-first", "Z First", "Artist Z", 60_000, 1],
      ["a-second", "A Second", "Artist A", 61_000, 0.9],
    ],
  },
  {
    rawPath: "raw/innertube-integer-order.json",
    fixturePath: "fixtures/responses/search-integer-order.json",
    rawKeys: ["2", "10", "zLast"],
    excludedId: "missing-result",
    results: [
      ["numeric-2", "Two", "Artist", 62_000, 1],
      ["numeric-10", "Ten", "Artist", 70_000, 0.9],
      ["string-last", "Last", "Artist", 63_000, 0.8],
    ],
  },
  {
    rawPath: "raw/innertube-nested-duplicates-cap.json",
    fixturePath: "fixtures/responses/search-nested-duplicates-cap.json",
    rawKeys: ["zFirst", "aSecond", "nested", "late", "outside"],
    excludedId: "outside-slot",
    results: [
      ["z-first", "Z First", "Artist", 60_000, 1],
      ["a-second", "A Second", "Artist", 61_000, 0.9],
      ["nested-outer", "Nested Outer", "Artist", 62_000, 0.8],
      ["nested-outer", "Nested Outer", "Artist", 62_000, 0.7],
      ["late-slot", "Late", "Artist", 64_000, 0.6],
    ],
  },
]
