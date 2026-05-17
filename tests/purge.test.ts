import { describe, expect, it } from "bun:test";
import {
  buildKillList,
  dataSlotsMatchUsedRoots,
  extractDataSlotValues,
  isKeepableNonClassSelector,
  purgeClasses,
} from "../src/postbuild-purge";
import type { PurgeManifest } from "../src/scan-consumer";

const checkboxManifest: PurgeManifest = {
  Checkbox: {
    classes: {
      always: ["checkbox"],
      byProp: {
        slot: {
          input: ["checkbox__input"],
          control: ["checkbox__control"],
          indicator: ["checkbox__indicator"],
        },
        variant: {
          primary: ["checkbox--primary"],
          secondary: ["checkbox--secondary"],
        },
        disabled: ["checkbox--disabled"],
      },
    },
  },
  Button: {
    classes: {
      always: ["button"],
      byProp: {
        variant: {
          primary: ["button--primary"],
          ghost: ["button--ghost"],
        },
      },
    },
  },
};

describe("extractDataSlotValues", () => {
  it("extracts quoted values", () => {
    expect(extractDataSlotValues('[data-slot="checkbox-default-indicator--checkmark"]')).toEqual([
      "checkbox-default-indicator--checkmark",
    ]);
  });

  it("extracts unquoted (post-minify) values", () => {
    expect(extractDataSlotValues("[data-slot=checkbox-default-indicator--checkmark]")).toEqual([
      "checkbox-default-indicator--checkmark",
    ]);
  });

  it("returns empty when no data-slot present", () => {
    expect(extractDataSlotValues(".checkbox[data-selected=true]")).toEqual([]);
  });

  it("extracts multiple slots from a compound selector", () => {
    expect(
      extractDataSlotValues(
        '[data-slot="checkbox-default-indicator--checkmark"] [data-slot="checkbox-default-indicator--indeterminate"]',
      ),
    ).toEqual([
      "checkbox-default-indicator--checkmark",
      "checkbox-default-indicator--indeterminate",
    ]);
  });
});

describe("dataSlotsMatchUsedRoots", () => {
  const used = new Set(["checkbox"]);

  it("matches data-slot starting with a used root + '-'", () => {
    expect(
      dataSlotsMatchUsedRoots('[data-slot="checkbox-default-indicator--checkmark"]', used),
    ).toBe(true);
  });

  it("matches data-slot starting with a used root + '__'", () => {
    expect(dataSlotsMatchUsedRoots('[data-slot="checkbox__indicator"]', used)).toBe(true);
  });

  it("matches data-slot exactly equal to a used root", () => {
    expect(dataSlotsMatchUsedRoots('[data-slot="checkbox"]', used)).toBe(true);
  });

  it("does not match data-slot for an unused component", () => {
    expect(
      dataSlotsMatchUsedRoots('[data-slot="unused-component-indicator"]', used),
    ).toBe(false);
  });

  it("requires every data-slot to match (compound selectors)", () => {
    expect(
      dataSlotsMatchUsedRoots(
        '[data-slot="checkbox-indicator"] [data-slot="unused-thing"]',
        used,
      ),
    ).toBe(false);
  });

  it("returns false when no data-slot is present", () => {
    expect(dataSlotsMatchUsedRoots(".foo[data-selected=true]", used)).toBe(false);
  });
});

describe("isKeepableNonClassSelector", () => {
  const used = new Set(["checkbox"]);

  it("preserves [data-slot] rules for used components", () => {
    expect(
      isKeepableNonClassSelector(
        '[data-slot="checkbox-default-indicator--checkmark"]',
        used,
      ),
    ).toBe(true);
  });

  it("drops [data-slot] rules for unused components", () => {
    expect(
      isKeepableNonClassSelector('[data-slot="unused-thing-indicator"]', used),
    ).toBe(false);
  });

  it("keeps fundamental selectors", () => {
    expect(isKeepableNonClassSelector(":root", used)).toBe(true);
    expect(isKeepableNonClassSelector("*", used)).toBe(true);
    expect(isKeepableNonClassSelector("html", used)).toBe(true);
  });

  it("keeps theme + hidden selectors", () => {
    expect(isKeepableNonClassSelector("[data-theme=dark]", used)).toBe(true);
    expect(isKeepableNonClassSelector("[hidden]", used)).toBe(true);
  });

  it("drops bare element selectors", () => {
    expect(isKeepableNonClassSelector("sub", used)).toBe(false);
    expect(isKeepableNonClassSelector("img", used)).toBe(false);
  });
});

describe("buildKillList", () => {
  it("exposes BEM roots for used components", () => {
    const { usedBemRoots } = buildKillList(checkboxManifest, new Set(["Checkbox"]));
    expect(usedBemRoots.has("checkbox")).toBe(true);
    expect(usedBemRoots.has("button")).toBe(false);
  });

  it("kills BEM classes from unused components", () => {
    const { killList } = buildKillList(checkboxManifest, new Set(["Checkbox"]));
    expect(killList.has("button")).toBe(true);
    expect(killList.has("button--primary")).toBe(true);
    expect(killList.has("checkbox")).toBe(false);
  });
});

describe("purgeClasses — regression: checkbox base [data-slot] rule", () => {
  it("preserves base [data-slot] rule alongside the selected variant", () => {
    const css = `
      [data-slot="checkbox-default-indicator--checkmark"] {
        opacity: 0;
        stroke-dashoffset: 66;
      }
      .checkbox[data-selected="true"] [data-slot="checkbox-default-indicator--checkmark"] {
        opacity: 1;
        stroke-dashoffset: 44;
      }
    `;
    const { killList, usedBemRoots } = buildKillList(
      checkboxManifest,
      new Set(["Checkbox"]),
    );
    const out = purgeClasses(css, killList, usedBemRoots);
    expect(out).toContain('[data-slot="checkbox-default-indicator--checkmark"]');
    expect(out).toContain("opacity: 0");
    expect(out).toContain("stroke-dashoffset: 66");
    expect(out).toContain("opacity: 1");
  });

  it("drops [data-slot] rules for unused components", () => {
    const css = `
      [data-slot="unused-component-thing"] { opacity: 0; }
    `;
    const { killList, usedBemRoots } = buildKillList(
      checkboxManifest,
      new Set(["Checkbox"]),
    );
    const out = purgeClasses(css, killList, usedBemRoots);
    expect(out).not.toContain("unused-component-thing");
  });

  it("handles grouped selectors", () => {
    const css = `
      [data-slot="checkbox-default-indicator--checkmark"],
      [data-slot="checkbox-default-indicator--indeterminate"] {
        opacity: 0;
      }
    `;
    const { killList, usedBemRoots } = buildKillList(
      checkboxManifest,
      new Set(["Checkbox"]),
    );
    const out = purgeClasses(css, killList, usedBemRoots);
    expect(out).toContain("checkbox-default-indicator--checkmark");
    expect(out).toContain("checkbox-default-indicator--indeterminate");
  });

  it("keeps existing class-based purge behavior intact", () => {
    const css = `
      .button { color: red; }
      .button--primary { color: blue; }
      .checkbox { color: green; }
    `;
    const { killList, usedBemRoots } = buildKillList(
      checkboxManifest,
      new Set(["Checkbox"]),
    );
    const out = purgeClasses(css, killList, usedBemRoots);
    expect(out).not.toContain(".button");
    expect(out).toContain(".checkbox");
  });

  it("preserves unquoted (post-minify) data-slot rules", () => {
    const css = "[data-slot=checkbox-default-indicator--checkmark]{opacity:0}";
    const { killList, usedBemRoots } = buildKillList(
      checkboxManifest,
      new Set(["Checkbox"]),
    );
    const out = purgeClasses(css, killList, usedBemRoots);
    expect(out).toContain("checkbox-default-indicator--checkmark");
  });
});
