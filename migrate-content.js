/* ================================================================
   migrate-content.js — One-time migration of content.json → Firestore
   ================================================================
   USAGE:  Open browser console on the live site and run:
             McgheeLab.migrateContent()

   Or from the Admin panel (future feature).
   This is idempotent-safe: running twice creates duplicates,
   so only run once per environment.
   ================================================================ */

window.McgheeLab = window.McgheeLab || {};

McgheeLab.migrateContent = async function () {
  if (!McgheeLab.db) {
    console.error('Firebase not configured. Edit firebase-config.js first.');
    return;
  }

  console.log('Starting content migration...');
  let count = 0;

  try {
    const res = await fetch('content.json', { cache: 'no-cache' });
    const data = await res.json();

    // ── Research topics ──
    const topics = data.research?.topics || [];
    for (let i = 0; i < topics.length; i++) {
      const t = topics[i];
      await McgheeLab.db.collection('research').add({
        title:    t.title || '',
        subtitle: t.subtitle || '',
        summary:  t.summary || '',
        image:    t.image || null,
        imageAlt: t.imageAlt || '',
        keywords: t.keywords || [],
        story:    t.story || [],
        order:    i,
        source:   'migrated',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      console.log('  Research:', t.title);
      count++;
    }

    // ── Projects → Stories ──
    const projects = data.projects || [];
    for (const p of projects) {
      const sections = (p.story || []).map((sec, i) => ({
        text:     sec.text || '',
        image:    sec.image ? { full: sec.image, medium: sec.image, thumb: sec.image } : null,
        imageAlt: sec.imageAlt || '',
        order:    i
      }));

      await McgheeLab.db.collection('stories').add({
        title:       p.title || '',
        project:     p.title || '',
        description: p.summary || '',
        authorUid:   'system',
        authorName:  'McGhee Lab',
        sections:    sections,
        status:      'published',
        source:      'migrated',
        tags:        p.tags || [],
        link:        p.link || '',
        createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
        publishedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      console.log('  Project:', p.title);
      count++;
    }

    // ── Team members (as non-user profiles) ──
    const team = data.team || {};
    for (const [category, members] of Object.entries(team)) {
      for (const m of (members || [])) {
        if (!m.name) continue;
        await McgheeLab.db.collection('teamProfiles').add({
          name:     m.name,
          role:     m.role || '',
          bio:      m.bio || '',
          photo:    m.photo ? { full: m.photo, medium: m.photo, thumb: m.photo } : null,
          category: category,
          registered: false,
          source:   'migrated',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        console.log('  Team:', m.name, '(' + category + ')');
        count++;
      }
    }

    console.log(`Migration complete! ${count} documents created.`);
  } catch (err) {
    console.error('Migration failed:', err);
  }
};
