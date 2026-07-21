import { XMLParser } from "fast-xml-parser";

import { readAllowedArchive } from "./archive.js";

const MAX_SHEETS = 10;
const MAX_ROWS = 100_000;
const MAX_XLSX_BYTES = 50 * 1024 * 1024;

type XmlValue = Record<string, unknown> | string | number | undefined;

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function assertSafeXml(xml: string): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error("XLSX contains prohibited XML declarations");
  }
}

function parseXml(xml: string): Record<string, unknown> {
  assertSafeXml(xml);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    processEntities: false,
    parseTagValue: false,
  });
  return parser.parse(xml) as Record<string, unknown>;
}

function textFromInline(value: XmlValue): string {
  if (value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  const text = value.t;
  if (typeof text === "string" || typeof text === "number") return String(text);
  const runs = arrayOf(value.r as Record<string, unknown> | Record<string, unknown>[] | undefined);
  return runs.map((run) => textFromInline(run)).join("");
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase();
  if (!letters) throw new Error(`Invalid XLSX cell reference: ${reference}`);
  let result = 0;
  for (const character of letters) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result - 1;
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const parsed = parseXml(xml);
  const table = parsed.sst as Record<string, unknown> | undefined;
  return arrayOf(table?.si as Record<string, unknown> | Record<string, unknown>[] | undefined).map(
    (item) => textFromInline(item),
  );
}

function cellValue(cell: Record<string, unknown>, shared: string[]): string {
  const type = cell["@_t"];
  if (type === "inlineStr") return textFromInline(cell.is as XmlValue);
  const raw = cell.v;
  const value = raw === undefined ? "" : String(raw);
  if (type === "s") {
    const index = Number(value);
    if (!Number.isInteger(index) || shared[index] === undefined) {
      throw new Error("XLSX references an invalid shared string");
    }
    return shared[index];
  }
  return value;
}

export interface WorkbookRows {
  checksum: string;
  fingerprint: string;
  rows: string[][];
}

export async function readFirstWorksheet(path: string): Promise<WorkbookRows> {
  const archive = await readAllowedArchive(
    path,
    new Set(["workbook.xml", "sheet1.xml", "sharedStrings.xml"]),
  );
  const workbookBuffer = archive.entries.get("workbook.xml");
  const sheetBuffer = archive.entries.get("sheet1.xml");
  if (!workbookBuffer || !sheetBuffer) {
    throw new Error("XLSX must contain a workbook and first worksheet");
  }
  if (workbookBuffer.length + sheetBuffer.length > MAX_XLSX_BYTES) {
    throw new Error("XLSX content exceeds 50 MB");
  }
  const workbook = parseXml(workbookBuffer.toString("utf8"));
  const sheets = arrayOf(
    ((workbook.workbook as Record<string, unknown> | undefined)?.sheets as
      | Record<string, unknown>
      | undefined)?.sheet as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  if (sheets.length === 0 || sheets.length > MAX_SHEETS) {
    throw new Error("XLSX must contain between 1 and 10 sheets");
  }
  const shared = parseSharedStrings(
    archive.entries.get("sharedStrings.xml")?.toString("utf8"),
  );
  const worksheet = parseXml(sheetBuffer.toString("utf8"));
  const sheetData = (worksheet.worksheet as Record<string, unknown> | undefined)?.sheetData as
    | Record<string, unknown>
    | undefined;
  const xmlRows = arrayOf(
    sheetData?.row as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  if (xmlRows.length > MAX_ROWS) throw new Error("XLSX exceeds 100,000 rows");
  const rows = xmlRows.map((row) => {
    const cells = arrayOf(
      row.c as Record<string, unknown> | Record<string, unknown>[] | undefined,
    );
    const values: string[] = [];
    for (const cell of cells) {
      const reference = cell["@_r"];
      if (typeof reference !== "string") throw new Error("XLSX cell is missing a reference");
      values[columnIndex(reference)] = cellValue(cell, shared);
    }
    return values.map((value) => value ?? "");
  });
  return { checksum: archive.checksum, fingerprint: archive.fingerprint, rows };
}
