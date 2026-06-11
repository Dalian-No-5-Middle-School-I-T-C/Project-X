import type { BlankLabelStyle } from "./types";

function romanNumeral(value: number): string {
  const numerals: Array<[number, string]> = [
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"]
  ];
  let remaining = value;
  let result = "";
  for (const [amount, label] of numerals) {
    while (remaining >= amount) {
      result += label;
      remaining -= amount;
    }
  }
  return result;
}

export function formatBlankLabel(style: BlankLabelStyle | undefined, index: number): string {
  if (!style || style === "none") return "";
  if (style === "roman_parentheses") return `(${romanNumeral(index + 1)})`;
  return `(${index + 1})`;
}
