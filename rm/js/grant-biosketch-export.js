/* grant-biosketch-export.js — V3.178.
 *
 * Word-compatible export for biosketch variants.
 *
 * Strategy: render the same HTML the on-screen biosketch uses, but wrap
 * it in a minimal HTML-Word document. Microsoft Word, Google Docs, and
 * LibreOffice all open .doc HTML-Word documents natively (it's the same
 * trick MS Office has accepted since Word 2003). This avoids dragging in
 * JSZip + a full Office Open XML template just to get a downloadable file.
 *
 * For NIH submission users will usually print to PDF anyway; the .doc
 * download is mostly for editorial collaboration with co-PIs over Word.
 *
 * Public API: window.GRANT_BIOSKETCH_EXPORT.downloadDocx(cv, variant)
 */

(function () {
  'use strict';

  function buildDocHtml(title, bodyHtml) {
    // Microsoft Word's "Web Page (Filtered)" format. UTF-8, simple inline
    // CSS that survives Word's import (no @media print — Word ignores it).
    return ''
      + '<!DOCTYPE html>'
      + '<html xmlns:o="urn:schemas-microsoft-com:office:office" '
      +       'xmlns:w="urn:schemas-microsoft-com:office:word" '
      +       'xmlns="http://www.w3.org/TR/REC-html40">'
      + '<head>'
      +   '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">'
      +   '<title>' + escapeHtml(title) + '</title>'
      +   '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View>'
      +   '<w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument>'
      +   '</xml><![endif]-->'
      +   '<style>'
      +     '@page { size: 8.5in 11in; margin: 0.5in; }'
      +     'body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #111; line-height: 1.35; }'
      +     'h1 { font-size: 14pt; margin: 0 0 6pt; }'
      +     'h2 { font-size: 11pt; font-weight: bold; margin: 14pt 0 4pt; border-bottom: 1px solid #888; padding-bottom: 2pt; }'
      +     'h3 { font-size: 11pt; font-weight: bold; margin: 8pt 0 2pt; }'
      +     'p, ul, ol { margin: 4pt 0; }'
      +     'ul, ol { padding-left: 18pt; }'
      +     'li { margin-bottom: 2pt; }'
      +     'table { border-collapse: collapse; width: 100%; margin: 4pt 0 8pt; font-size: 10pt; }'
      +     'th, td { border: 1px solid #999; padding: 3pt 5pt; text-align: left; vertical-align: top; }'
      +     'th { background: #f0f0f0; font-weight: bold; }'
      +     '.gd-name { font-weight: bold; font-size: 13pt; }'
      +     '.gd-position { font-size: 10pt; color: #333; }'
      +     '.gd-header { border-bottom: 1px solid #000; padding-bottom: 4pt; margin-bottom: 10pt; }'
      +     '.gd-contribution { border-left: 3px solid #bbb; padding-left: 8pt; margin: 6pt 0; }'
      +     '.gd-citation { font-size: 10pt; padding-left: 1.5em; text-indent: -1.5em; margin: 2pt 0; }'
      +     '.gd-empty { font-style: italic; color: #888; }'
      +   '</style>'
      + '</head>'
      + '<body>' + bodyHtml + '</body>'
      + '</html>';
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function stripEditableUi(html) {
    // Remove action buttons and contenteditable attributes so the export
    // is a clean document, not the editor surface.
    return html
      .replace(/<button[^>]*data-gd-action[^>]*>.*?<\/button>/g, '')
      .replace(/<div[^>]*data-gd-action[^>]*>.*?<\/div>/g, '')
      .replace(/\sdata-gd-(?:edit|edit-contrib|edit-synact|action|contributions|synactivities)(?:="[^"]*")?/g, '')
      .replace(/\scontenteditable="[^"]*"/g, '')
      .replace(/\sdata-placeholder="[^"]*"/g, '')
      .replace(/\sdata-idx="[^"]*"/g, '')
      .replace(/\sdata-maxlen="[^"]*"/g, '');
  }

  function downloadBlob(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 250);
  }

  function safeName(label) {
    return String(label || 'biosketch').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '');
  }

  function downloadDocx(cv, variant) {
    if (!variant) return;
    var rendered = window.GRANT_BIOSKETCH.renderForMechanism(cv, variant);
    var cleaned = stripEditableUi(rendered);
    var title = (variant.label || 'biosketch') + ' (' + (variant.mechanism || '') + ')';
    var html = buildDocHtml(title, cleaned);
    // Word treats application/msword on a .doc extension as HTML-Word.
    var blob = new Blob(['﻿', html], { type: 'application/msword' });
    downloadBlob(safeName(variant.label || 'biosketch') + '.doc', blob);
  }

  function downloadFacilitiesDocx(doc) {
    if (!doc) return;
    var sections = doc.sections || {};
    var html = ''
      + '<h1>' + escapeHtml(doc.label || 'Facilities & Other Resources') + '</h1>'
      + '<h2>Facilities</h2>'    + (sections.facilities || '')
      + '<h2>Equipment</h2>'     + (sections.equipment || '')
      + '<h2>Computing</h2>'     + (sections.computing || '')
      + '<h2>Office</h2>'        + (sections.office || '')
      + '<h2>Other Resources</h2>' + (sections.otherResources || '');
    var cleaned = stripEditableUi(html);
    var wrapped = buildDocHtml(doc.label || 'Facilities', cleaned);
    var blob = new Blob(['﻿', wrapped], { type: 'application/msword' });
    downloadBlob(safeName(doc.label || 'facilities') + '.doc', blob);
  }

  window.GRANT_BIOSKETCH_EXPORT = {
    downloadDocx: downloadDocx,
    downloadFacilitiesDocx: downloadFacilitiesDocx,
  };
})();
