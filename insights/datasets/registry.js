/**
 * Static registry of every dataset Aspect Intelligence can potentially serve —
 * the structural facts that don't change at runtime (which schema, which pool,
 * default branding) plus sensible starting defaults for the admin-editable
 * config (see ../services/intelligence-config.service.js, which layers
 * per-dataset overrides — enabled flag, data model description, brand label,
 * bootstrap/example prompts — on top of these defaults via the generic
 * `provider_config` table, the same pattern services/schedule-config.service.js
 * already uses).
 *
 * Adding a 7th dataset later: add one entry here (reusing its existing
 * services/db.<id>.js pool getter) — nothing else needs to change for it to
 * show up in the admin panel and, once enabled there, in the public product.
 */

const hypertoy = require('../../services/db.hypertoy');
const zer4u = require('../../services/db.zer4u');
const newdeli = require('../../services/db.newdeli');
const thestock = require('../../services/db.thestock');
const zolstock = require('../../services/db.zolstock');
const tevanaot = require('../../services/db.tevanaot');

const REGISTRY = {
  hypertoy: {
    id: 'hypertoy',
    schemaName: 'hypertoy',
    getPool: hypertoy.getPool,
    defaultMeta: {
      name: 'Hyper Toy',
      description: 'AI-powered business intelligence for the Hyper Toy toy retail chain — sales, profit, inventory, customers.',
      logoText: 'HT',
      gradientFrom: '#8B5CF6',
      gradientTo: '#D946EF',
    },
    defaultBrandLabel: 'Hyper Toy, a toy retail chain',
    defaultDataModelDescription: 'a facts table with sales, inventory, and target rows (record types), joined to products, stores/warehouses, and customers. Common measures: revenue (ex VAT), profit, margin %, units sold, target attainment %, inventory value/units, loyalty signups. Common dimensions: store, region, branch, product, product family, date (day/week/month/quarter), cashier, campaign, customer city. IMPORTANT: sales targets/attainment exist only at store+time granularity — never ask for target attainment broken down by product/product family/SKU, that dimension does not exist on target rows.',
    defaultBootstrapPrompts: [
      'Which stores are furthest behind their sales target this quarter, and why',
      'Which product family has the steepest margin decline recently',
      'Which SKUs are tying up the most inventory value with the slowest sell-through',
      'What is the loyalty signup trend over the last several weeks, and what is driving it',
    ],
    defaultExamplePrompts: [
      'Main risks for the next 6 months',
      'Which stores will miss Q3 target',
      'Which product family has the steepest margin decline',
    ],
  },
  zer4u: {
    id: 'zer4u',
    schemaName: 'zer4u',
    getPool: zer4u.getPool,
    defaultMeta: {
      name: 'Zer4U',
      description: 'AI-powered business intelligence for Zer4U, a florist and gift retail chain — sales, targets, inventory, customers.',
      logoText: 'Z4',
      gradientFrom: '#0D9488',
      gradientTo: '#14B8A6',
    },
    defaultBrandLabel: 'Zer4U, a florist and gift retail chain',
    defaultDataModelDescription: 'BI-correct sales, revenue and transaction-count figures come only from materialized views (never the raw sales table), joined to stores, items (with a real item_group product category), and customers, plus a targets table for sales-target attainment by store. Common measures: revenue and profit (ex VAT), transaction count, quantity sold, inventory value/stock, target attainment %. Common dimensions: store, item/product, item category, date (day/week/month/quarter/year), customer.',
    defaultBootstrapPrompts: [
      'Which stores are furthest behind their sales target this quarter, and why',
      'Which product categories have the steepest revenue decline recently',
      'Which items are tying up the most inventory value with the slowest sell-through',
      'What is the customer count trend over the last several months, and what is driving it',
    ],
    defaultExamplePrompts: [
      'Main risks for the next 6 months',
      'Which stores will miss this quarter\'s target',
      'Which product category has the steepest revenue decline',
    ],
  },
  newdeli: {
    id: 'newdeli',
    schemaName: 'newdeli',
    getPool: newdeli.getPool,
    defaultMeta: {
      name: 'New Deli',
      description: 'AI-powered business intelligence for New Deli — completed orders, branches, order items.',
      logoText: 'ND',
      gradientFrom: '#EA580C',
      gradientTo: '#F59E0B',
    },
    defaultBrandLabel: 'New Deli, a food ordering/delivery business',
    defaultDataModelDescription: 'an order-level facts table (each row is one completed order, status = completed) joined to branches, plus an order_items table for item-level basket detail. Common measures: order count, revenue, average order value. Common dimensions: branch, month, order item/dish.',
    defaultBootstrapPrompts: [
      'Which branches have the steepest order-volume decline over the last few months',
      'Which dishes/items appear most often in recent completed orders',
      'What is the average order value trend over the last several months',
      'Which branch has the highest average order value',
    ],
    defaultExamplePrompts: [
      'Main risks for the next few months',
      'Which branches are declining fastest',
      'What is driving the average order value trend',
    ],
  },
  thestock: {
    id: 'thestock',
    schemaName: 'thestock',
    getPool: thestock.getPool,
    defaultMeta: {
      name: 'The Stock',
      description: 'AI-powered business intelligence for The Stock discount retail chain — sales, inventory, targets, customers.',
      logoText: 'TS',
      gradientFrom: '#2563EB',
      gradientTo: '#6366F1',
    },
    defaultBrandLabel: 'The Stock, a discount retail chain',
    defaultDataModelDescription: 'a large facts table mixing sales/inventory/targets/purchase-order rows by record type, pre-aggregated into daily materialized views by SKU, store, and cashier for fast BI queries, joined to products, warehouses, and customers. Common measures: revenue (ex/inc VAT), quantity sold, transaction count, loyalty signups, inventory balance/value. Common dimensions: store/warehouse, product/SKU, cashier, date (day/week/month/quarter), customer.',
    defaultBootstrapPrompts: [
      'Which stores are furthest behind their sales target this quarter, and why',
      'Which products have the steepest sales decline recently',
      'Which SKUs are tying up the most inventory value with the slowest sell-through',
      'What is the loyalty signup trend over the last several weeks, and what is driving it',
    ],
    defaultExamplePrompts: [
      'Main risks for the next 6 months',
      'Which stores will miss this quarter\'s target',
      'Which products have the steepest sales decline',
    ],
  },
  zolstock: {
    id: 'zolstock',
    schemaName: 'zolstock',
    getPool: zolstock.getPool,
    defaultMeta: {
      name: 'Zol Stock',
      description: 'AI-powered business intelligence for Zol Stock, a discount retail chain — sales, inventory, agent/wholesale.',
      logoText: 'ZS',
      gradientFrom: '#1D4ED8',
      gradientTo: '#FACC15',
    },
    defaultBrandLabel: 'Zol Stock, a discount retail chain',
    defaultDataModelDescription: 'a wide facts table mixing sales, inventory, and wholesale-agent rows by record type, pre-aggregated into daily materialized views by item, store, and seller. Common measures: revenue and profit (ex VAT), quantity sold, inventory quantity. Common dimensions: store, item, seller, date (day/week/month). Product/customer/store name dimensions are not yet loaded — only numeric ids are available for grouping until those files arrive.',
    defaultBootstrapPrompts: [
      'Which stores have the steepest sales decline recently',
      'Which items are tying up the most inventory quantity',
      'What is the daily revenue trend over the last several weeks',
      'Which sellers have the highest sales volume',
    ],
    defaultExamplePrompts: [
      'Main risks for the next few months',
      'Which stores are declining fastest',
      'Which items are overstocked',
    ],
  },
  tevanaot: {
    id: 'tevanaot',
    schemaName: 'tevanaot',
    getPool: tevanaot.getPool,
    defaultMeta: {
      name: 'Teva Naot',
      description: 'AI-powered business intelligence for Teva Naot, a footwear retail chain — sales, inventory, orders, customers.',
      logoText: 'TN',
      gradientFrom: '#78350F',
      gradientTo: '#D97706',
    },
    defaultBrandLabel: 'Teva Naot, a footwear retail chain',
    defaultDataModelDescription: 'resolved item-level sales (from a QlikSense export, already resolved into clean columns) joined to parts (product: model/color/size/shoe type/gender/season), sites (store/warehouse), and customers, plus inventory and purchase-order tables. Common measures: revenue, quantity sold, inventory stock/value, order quantity. Common dimensions: store/site, product (model, color, size, shoe type, gender, season), date (day/week/month/quarter), customer.',
    defaultBootstrapPrompts: [
      'Which stores have the steepest sales decline recently',
      'Which shoe models/colors are tying up the most inventory value with the slowest sell-through',
      'What is the sales trend by shoe category over the last several months',
      'Which suppliers have the most open purchase orders',
    ],
    defaultExamplePrompts: [
      'Main risks for the next 6 months',
      'Which stores are declining fastest',
      'Which shoe models are overstocked',
    ],
  },
};

/** @returns {Object|null} the registry entry for a dataset id, or null if unknown. */
function get(datasetId) {
  return REGISTRY[datasetId] || null;
}

function all() {
  return Object.values(REGISTRY);
}

module.exports = { get, all };
