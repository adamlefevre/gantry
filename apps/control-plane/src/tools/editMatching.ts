// Exact-text edit matching for the editFile tool.
//
// Ported from eve (https://github.com/vercel/eve, packages/eve/src/tools/provided/edit-file.ts,
// 1.0.0-rc.9, Apache-2.0), which ported it from pi's `edit` tool (https://github.com/badlogic/pi-mono,
// packages/coding-agent/src/core/tools/edit.ts and edit-diff.ts, MIT). See NOTICE.
//
// Changes from eve: no sandbox access (the caller reads and writes the file), and these
// pure functions are exported for unit tests.

export interface Edit {
  oldText: string;
  newText: string;
}

/**
 * Repairs the shapes models send instead of `{path, edits: [...]}`: `edits` as a JSON string
 * or a single object, and a top-level `oldText`/`newText` pair. Runs before schema validation.
 */
export function prepareEditArguments(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const args: Record<string, unknown> = { ...input };

  if (typeof args.edits === "string") {
    try {
      const parsed: unknown = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
      else if (isSingleEdit(parsed)) args.edits = [parsed];
    } catch {
      // Leave it for validation to reject.
    }
  } else if (isSingleEdit(args.edits)) {
    args.edits = [args.edits];
  }

  if (typeof args.oldText !== "string" || typeof args.newText !== "string") return args;
  const { oldText, newText, ...rest } = args;
  const edits = Array.isArray(rest.edits) ? [...rest.edits] : [];
  edits.push({ oldText, newText });
  return { ...rest, edits };
}

/**
 * Applies `edits` to a file's text and returns the new text. Every edit is matched against
 * the original, not incrementally. Keeps a leading BOM and the file's CRLF line endings.
 * Throws an error the model can act on when an edit is missing, ambiguous, overlapping,
 * empty, or changes nothing.
 */
export function applyEdits(original: string, edits: readonly Edit[], path: string): string {
  if (edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  // The model will not include an invisible BOM in oldText.
  const { bom, text } = splitBom(original);
  const ending = detectLineEnding(text);
  const updated = applyEditsToNormalizedContent(normalizeToLF(text), edits, path);
  return bom + restoreLineEndings(updated, ending);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSingleEdit(value: unknown): value is Edit {
  return isRecord(value) && typeof value.oldText === "string" && typeof value.newText === "string";
}

function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith("﻿")
    ? { bom: "﻿", text: content.slice(1) }
    : { bom: "", text: content };
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1 || crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalizes text for fuzzy matching: strips trailing whitespace from each line and maps
 * smart quotes, Unicode dashes, and special spaces to ASCII.
 */
function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      // U+2010 hyphen through U+2015 horizontal bar, and U+2212 minus.
      .replace(/[‐‑‒–—―−]/g, "-")
      .replace(/[  -   　]/g, " ")
  );
}

interface LineSpan {
  start: number;
  end: number;
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;

  const startLine = lines.findIndex(
    (line) => replacementStart >= line.start && replacementStart < line.end
  );
  if (startLine === -1) {
    throw new Error("Replacement range is outside the base content.");
  }

  let endLine = startLine;
  while (endLine < lines.length && lines[endLine]!.end < replacementEnd) {
    endLine++;
  }
  if (endLine >= lines.length) {
    throw new Error("Replacement range is outside the base content.");
  }

  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i]!;
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.substring(0, matchIndex) +
      replacement.newText +
      result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}

/**
 * Applies replacements matched against a fuzzy-normalized `baseContent` to `originalContent`:
 * only the lines a replacement touches are rewritten from the normalized base, and every
 * other line keeps its original bytes.
 */
function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[]
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error(
      "Cannot preserve unchanged lines because the base content has a different line count."
    );
  }

  const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
  const sorted = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sorted) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups.at(-1);
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }

  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const groupStartOffset = baseLines[group.startLine]!.start;
    const groupEndOffset = baseLines[group.endLine - 1]!.end;
    result += applyReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset
    );
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join("");
  return result;
}

interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
}

/** Finds oldText exactly, then in fuzzy-normalized space, where offsets refer to normalized content. */
function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
  }
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = normalizeForFuzzyMatch(content).indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  }
  return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true };
}

function countOccurrences(content: string, oldText: string): number {
  return normalizeForFuzzyMatch(content).split(normalizeForFuzzyMatch(oldText)).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
    );
  }
  return new Error(
    `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`
  );
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
    );
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`
  );
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) return new Error(`oldText must not be empty in ${path}.`);
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
    );
  }
  return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Applies exact-text replacements to LF-normalized content. When any edit needs fuzzy
 * matching, all of them are matched in fuzzy-normalized space and the touched lines are
 * overlaid onto the original, so unchanged lines keep their bytes.
 */
function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: readonly Edit[],
  path: string
): string {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i]!.oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length);
    }
  }

  const usedFuzzyMatch = normalizedEdits.some(
    (edit) => fuzzyFindText(normalizedContent, edit.oldText).usedFuzzyMatch
  );
  const baseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i]!;
    const match = fuzzyFindText(baseContent, edit.oldText);
    if (!match.found) throw getNotFoundError(path, i, normalizedEdits.length);

    const occurrences = countOccurrences(baseContent, edit.oldText);
    if (occurrences > 1) throw getDuplicateError(path, i, normalizedEdits.length, occurrences);

    matchedEdits.push({
      editIndex: i,
      matchIndex: match.index,
      matchLength: match.matchLength,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1]!;
    const current = matchedEdits[i]!;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`
      );
    }
  }

  const newContent = usedFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(normalizedContent, baseContent, matchedEdits)
    : applyReplacements(baseContent, matchedEdits);

  if (normalizedContent === newContent) throw getNoChangeError(path, normalizedEdits.length);
  return newContent;
}
