/* links.js — bidirectional item ↔ task-bucket links.
 *
 * An "item" is a row in data/items.json (research_project, grant, paper,
 * course, conference, etc.) or in one of the data/service/*.json files
 * adapted on read. A "bucket" is a project node in data/tasks/buckets.json.
 *
 * Schema additions (both optional, default empty):
 *   items.json item:           linked_bucket_ids: [string]
 *   buckets.json project node: linked_item_ids:   [string]
 *
 * Pinning an item to the dashboard means: ensure a linked bucket exists,
 * remove it from state.hidden on the dashboard, and let the existing
 * dashboard renderer pick it up. If no link exists yet, an empty bucket
 * is auto-created and linked.
 *
 * Exposes window.LINKS:
 *   linkedBucketsForItem(item, bucketsDoc)    → [bucketProject]
 *   linkedItemsForBucket(project, itemsDoc)   → [item]
 *   addLink(itemId, bucketId)                 → fetch both, add+save
 *   removeLink(itemId, bucketId)              → fetch both, remove+save
 *   pinItemToDashboard(item, opts?)           → ensures bucket + unhides
 *   navigateToBucket(bucketId)                → window.location → tasks page
 *   navigateToItem(itemRef)                   → window.location → research/teaching/service
 */

(function () {
  const ITEMS_PATH = 'items.json';
  const BUCKETS_PATH = 'tasks/buckets.json';
  const HIDDEN_KEY = 'tasksDash.hiddenProjects';

  function loadItems() { return api.load(ITEMS_PATH); }
  function loadBuckets() { return api.load(BUCKETS_PATH); }
  function saveItems(d) { return api.save(ITEMS_PATH, d); }
  function saveBuckets(d) {
    d.updated_at = new Date().toISOString();
    return api.save(BUCKETS_PATH, d);
  }

  function linkedBucketsForItem(item, bucketsDoc) {
    const ids = (item && item.linked_bucket_ids) || [];
    if (!ids.length) return [];
    const projects = (bucketsDoc && bucketsDoc.projects) || [];
    return ids.map(id => projects.find(p => p.id === id)).filter(Boolean);
  }

  function linkedItemsForBucket(project, itemsDoc) {
    const ids = (project && project.linked_item_ids) || [];
    if (!ids.length) return [];
    const items = (itemsDoc && itemsDoc.items) || [];
    return ids.map(id => items.find(i => i.id === id)).filter(Boolean);
  }

  async function addLink(itemId, bucketId) {
    const [itemsDoc, bucketsDoc] = await Promise.all([loadItems(), loadBuckets()]);
    const item = (itemsDoc.items || []).find(i => i.id === itemId);
    const proj = (bucketsDoc.projects || []).find(p => p.id === bucketId);
    if (!item || !proj) throw new Error('addLink: item or bucket not found');
    if (!Array.isArray(item.linked_bucket_ids)) item.linked_bucket_ids = [];
    if (item.linked_bucket_ids.indexOf(bucketId) === -1) item.linked_bucket_ids.push(bucketId);
    if (!Array.isArray(proj.linked_item_ids)) proj.linked_item_ids = [];
    if (proj.linked_item_ids.indexOf(itemId) === -1) proj.linked_item_ids.push(itemId);
    await Promise.all([saveItems(itemsDoc), saveBuckets(bucketsDoc)]);
    return { item, project: proj };
  }

  async function removeLink(itemId, bucketId) {
    const [itemsDoc, bucketsDoc] = await Promise.all([loadItems(), loadBuckets()]);
    const item = (itemsDoc.items || []).find(i => i.id === itemId);
    const proj = (bucketsDoc.projects || []).find(p => p.id === bucketId);
    if (item && Array.isArray(item.linked_bucket_ids)) {
      item.linked_bucket_ids = item.linked_bucket_ids.filter(x => x !== bucketId);
    }
    if (proj && Array.isArray(proj.linked_item_ids)) {
      proj.linked_item_ids = proj.linked_item_ids.filter(x => x !== itemId);
    }
    await Promise.all([saveItems(itemsDoc), saveBuckets(bucketsDoc)]);
  }

  // Auto-create an empty bucket linked to this item (used when the user pins
  // an item to the dashboard but no bucket has been linked yet).
  function newProjectForItem(item) {
    const idStem = (item.id || 'item').replace(/^item-/, '');
    return {
      id: `proj-${idStem}-${Date.now().toString(36)}`,
      title: item.title || item.name || idStem,
      status: 'active',
      category: item.category || '',
      due_date: 'TBD',
      hours_estimate: 0,
      tracker_entry_id: null,
      evidence: { email_ids: [], event_ids: [], item_ids: [item.id] },
      notes: '',
      created_at: new Date().toISOString().slice(0, 10),
      completed_at: null,
      buckets: [],
      linked_item_ids: [item.id],
    };
  }

  // Ensure the item has at least one linked bucket and is not hidden on the
  // dashboard. Returns the bucket id that should be focused.
  async function pinItemToDashboard(item) {
    const [itemsDoc, bucketsDoc] = await Promise.all([loadItems(), loadBuckets()]);
    const fresh = (itemsDoc.items || []).find(i => i.id === item.id) || item;
    const ids = (fresh.linked_bucket_ids || []);
    let bucketId = null;
    if (ids.length) {
      bucketId = ids[0];
    } else {
      // Create + link a fresh empty bucket.
      const proj = newProjectForItem(fresh);
      bucketsDoc.projects = bucketsDoc.projects || [];
      bucketsDoc.projects.push(proj);
      if (!Array.isArray(fresh.linked_bucket_ids)) fresh.linked_bucket_ids = [];
      fresh.linked_bucket_ids.push(proj.id);
      await Promise.all([saveItems(itemsDoc), saveBuckets(bucketsDoc)]);
      bucketId = proj.id;
    }
    // Unhide on the dashboard so it shows up next time the user lands there.
    try {
      const hidden = new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]'));
      if (hidden.has(bucketId)) {
        hidden.delete(bucketId);
        localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
      }
    } catch {}
    return bucketId;
  }

  function categoryToPage(category) {
    if (category === 'teaching') return '/rm/pages/teaching.html';
    if (category === 'service')  return '/rm/pages/service.html';
    return '/rm/pages/projects.html';
  }

  function navigateToBucket(bucketId) {
    window.location.href = `/pages/tasks.html?project=${encodeURIComponent(bucketId)}`;
  }

  function navigateToItem(itemRef) {
    // itemRef may be a full item or just { id, category } / a bare id string.
    if (typeof itemRef === 'string') {
      window.location.href = `/pages/projects.html?item=${encodeURIComponent(itemRef)}`;
      return;
    }
    const page = categoryToPage(itemRef.category);
    window.location.href = `${page}?item=${encodeURIComponent(itemRef.id)}`;
  }

  window.LINKS = {
    linkedBucketsForItem,
    linkedItemsForBucket,
    addLink,
    removeLink,
    pinItemToDashboard,
    navigateToBucket,
    navigateToItem,
    loadBuckets,
    loadItems,
  };
})();
