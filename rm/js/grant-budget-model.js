/* grant-budget-model.js — V3.180.
 *
 * Pure calculation functions for grant budgets. No DOM, no I/O — testable
 * in isolation. UI lives in grant-budget.js.
 *
 * Year shape (one doc at grantDrafts/{id}/budget/{year}):
 *
 *   {
 *     year: 'Y1' | 'Y2' | ...,
 *     mode: 'modular' | 'detailed',
 *     modularAmount: 250000,
 *     fringeRates: { academic, summer, postdoc, student },
 *     idc: { rate, basis, excludeEquipmentAbove },
 *     escalation: 0.03,
 *     personnel:   [{ name, role, baseSalary, effortAcademicPct, effortSummerPct,
 *                     effortCalendarPct, fringeKind, notes }],
 *     equipment:   [{ item, vendor, cost, justification }],
 *     supplies:    [{ category, cost, notes }],
 *     travel:      [{ purpose, destinationKind, cost, attendees }],
 *     publications: 0,
 *     consultants: [{ name, rate, days }],
 *     subawards:   [{ institution, pi, directs, indirects }],
 *     otherDirect: [{ label, cost }],
 *   }
 *
 * Public API on window.GrantBudgetModel.
 */

(function () {
  'use strict';

  var DEFAULT_FRINGE = { academic: 0.30, summer: 0.105, postdoc: 0.27, student: 0.105 };
  var DEFAULT_IDC = { rate: 0.547, basis: 'MTDC', excludeEquipmentAbove: 5000 };

  function emptyYear(year) {
    return {
      year: year || 'Y1',
      mode: 'detailed',
      modularAmount: 250000,
      fringeRates: Object.assign({}, DEFAULT_FRINGE),
      idc: Object.assign({}, DEFAULT_IDC),
      escalation: 0.03,
      personnel: [],
      equipment: [],
      supplies: [],
      travel: [],
      publications: 0,
      consultants: [],
      subawards: [],
      otherDirect: [],
    };
  }

  function personnelCost(row, fringeRates, escalation, yearIdx) {
    if (!row) return { salary: 0, fringe: 0, total: 0 };
    var base = Number(row.baseSalary) || 0;
    var esc = Math.pow(1 + (Number(escalation) || 0), Math.max(0, yearIdx || 0));
    var academic = base * ((Number(row.effortAcademicPct) || 0) / 100);
    var summer   = base * ((Number(row.effortSummerPct)   || 0) / 100);
    var calendar = base * ((Number(row.effortCalendarPct) || 0) / 100);
    var salary = (academic + summer + calendar) * esc;
    var fr = (fringeRates && fringeRates[row.fringeKind || 'academic']) || 0;
    var fringe = salary * fr;
    return { salary: salary, fringe: fringe, total: salary + fringe };
  }

  function sum(arr, key) {
    return (arr || []).reduce(function (acc, x) { return acc + (Number(x && x[key]) || 0); }, 0);
  }

  function categoryTotals(year, yearIdx) {
    if (year.mode === 'modular') {
      var modular = Number(year.modularAmount) || 0;
      // Modular = 25k chunks of direct costs (excludes consortium F&A).
      return {
        personnel: 0, fringe: 0, equipment: 0, supplies: 0, travel: 0,
        publications: 0, consultants: 0, subawardsDirect: 0, subawardsIndirect: 0,
        otherDirect: 0, directs: modular,
      };
    }

    var fringeRates = year.fringeRates || DEFAULT_FRINGE;
    var escalation = Number(year.escalation) || 0;
    var personnelTotal = 0, fringeTotal = 0;
    (year.personnel || []).forEach(function (row) {
      var r = personnelCost(row, fringeRates, escalation, yearIdx);
      personnelTotal += r.salary;
      fringeTotal += r.fringe;
    });
    var equipment = sum(year.equipment, 'cost');
    var supplies = sum(year.supplies, 'cost');
    var travel = sum(year.travel, 'cost');
    var publications = Number(year.publications) || 0;
    var consultants = (year.consultants || []).reduce(function (acc, c) {
      return acc + (Number(c.rate) || 0) * (Number(c.days) || 0);
    }, 0);
    var subawardsDirect = sum(year.subawards, 'directs');
    var subawardsIndirect = sum(year.subawards, 'indirects');
    var otherDirect = sum(year.otherDirect, 'cost');

    var directs = personnelTotal + fringeTotal + equipment + supplies + travel
                + publications + consultants + subawardsDirect + subawardsIndirect + otherDirect;

    return {
      personnel: personnelTotal,
      fringe: fringeTotal,
      equipment: equipment,
      supplies: supplies,
      travel: travel,
      publications: publications,
      consultants: consultants,
      subawardsDirect: subawardsDirect,
      subawardsIndirect: subawardsIndirect,
      otherDirect: otherDirect,
      directs: directs,
    };
  }

  function mtdcBase(year, totals) {
    // MTDC = total directs minus (a) equipment over excludeAbove (one-time
    // and capital exclusions), (b) tuition, (c) rent, (d) subaward
    // portions over $25k each — applied per subaward, not summed.
    var t = totals || categoryTotals(year, 0);
    var excludeAbove = (year.idc && year.idc.excludeEquipmentAbove) || 5000;
    // Equipment items above the per-item threshold are excluded entirely.
    var excludedEquip = (year.equipment || []).reduce(function (acc, e) {
      var c = Number(e.cost) || 0;
      return acc + (c >= excludeAbove ? c : 0);
    }, 0);
    var includedEquip = t.equipment - excludedEquip;

    // Subawards: first $25k of EACH subaward's directs is included in MTDC;
    // the rest is excluded. Subaward indirects are always excluded.
    var subawardMtdc = (year.subawards || []).reduce(function (acc, s) {
      var d = Number(s.directs) || 0;
      return acc + Math.min(d, 25000);
    }, 0);

    var directsLessEquipment = t.directs - t.equipment - t.subawardsDirect - t.subawardsIndirect;
    return directsLessEquipment + includedEquip + subawardMtdc;
  }

  function idcAmount(mtdcBaseAmount, rate) {
    return (Number(mtdcBaseAmount) || 0) * (Number(rate) || 0);
  }

  function yearSummary(year, yearIdx) {
    var totals = categoryTotals(year, yearIdx || 0);
    var idcCfg = year.idc || DEFAULT_IDC;
    var base;
    if (idcCfg.basis === 'TDC') {
      base = totals.directs;
    } else {
      base = mtdcBase(year, totals);
    }
    var indirects = idcAmount(base, idcCfg.rate);
    var total = totals.directs + indirects;
    return {
      year: year.year,
      totals: totals,
      mtdcBase: base,
      indirects: indirects,
      total: total,
    };
  }

  function aggregateYears(years) {
    var summaries = (years || []).map(function (y, i) { return yearSummary(y, i); });
    var grand = { directs: 0, indirects: 0, total: 0, years: [] };
    summaries.forEach(function (s) {
      grand.directs   += s.totals.directs;
      grand.indirects += s.indirects;
      grand.total     += s.total;
      grand.years.push({ year: s.year, directs: s.totals.directs, indirects: s.indirects, total: s.total });
    });
    return grand;
  }

  window.GrantBudgetModel = {
    DEFAULT_FRINGE: DEFAULT_FRINGE,
    DEFAULT_IDC: DEFAULT_IDC,
    emptyYear: emptyYear,
    personnelCost: personnelCost,
    categoryTotals: categoryTotals,
    mtdcBase: mtdcBase,
    idcAmount: idcAmount,
    yearSummary: yearSummary,
    aggregateYears: aggregateYears,
  };
})();
