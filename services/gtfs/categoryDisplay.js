'use strict';

/**
 * categoryDisplay.js — the passenger-facing abbreviation for a GTFS category
 * ('ПВ', 'БВ', 'АВТ', ...), bilingual.
 *
 * Single source of truth: this table previously existed only inside
 * scheduleController.js (CATEGORY_EN) as English abbreviations for the
 * search results, with no equivalent for the armed-journey pipeline (whose
 * trainNumberDisplay was always Bulgarian regardless of appLanguage). Two
 * copies of "the same mapping" is exactly how they'd have drifted apart —
 * this one is shared by both.
 */

const CATEGORY_EN = {
    'ПВ':   'PT',
    'КПВ':  'SUT',
    'БВ':   'FT',
    'МБВ':  'IFT',
    'БВЗР': 'FT',
    'ЕВ':   'ET',
    'АВТ':  'BUS',
};

/**
 * @param {string} category  Bulgarian category letters, e.g. 'ПВ'
 * @param {string|null} language  'en' for the English abbreviation, anything
 *        else (including null/undefined) for the Bulgarian original.
 */
function abbrevFor(category, language) {
    if (language === 'en') return CATEGORY_EN[category] || category;
    return category;
}

module.exports = { abbrevFor, CATEGORY_EN };
