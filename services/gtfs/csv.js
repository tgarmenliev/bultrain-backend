'use strict';

/**
 * csv.js — a small RFC4180-ish parser, enough for GTFS text files.
 *
 * Handles: UTF-8 BOM, CRLF/LF, double-quoted fields, embedded commas and
 * newlines inside quotes, and "" as an escaped quote. Returns an array of
 * plain objects keyed by the header row.
 */

function parseCsv(text) {
    // Strip a leading UTF-8 BOM if present.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    const rows = [];
    let field = '';
    let record = [];
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];

        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }  // escaped quote
                else inQuotes = false;
            } else {
                field += c;
            }
            continue;
        }

        if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            record.push(field); field = '';
        } else if (c === '\n') {
            record.push(field); field = '';
            rows.push(record); record = [];
        } else if (c === '\r') {
            // swallow; the \n handles the record break
        } else {
            field += c;
        }
    }
    // Flush the final field/record if the file did not end with a newline.
    if (field.length > 0 || record.length > 0) {
        record.push(field);
        rows.push(record);
    }

    if (rows.length === 0) return [];
    const header = rows[0];
    const out = [];
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (row.length === 1 && row[0] === '') continue; // blank trailing line
        const obj = {};
        for (let c = 0; c < header.length; c++) obj[header[c]] = row[c] ?? '';
        out.push(obj);
    }
    return out;
}

module.exports = { parseCsv };
