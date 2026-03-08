interface Props {
  onBack: () => void;
}


export function AboutPage({ onBack }: Props) {
  return (
    <div style={styles.page}>
      <div style={styles.container}>

        {/* Header */}
        <div style={styles.header}>
          <button style={styles.backBtn} onClick={onBack}>← Back to map</button>
        </div>

        <h1 style={styles.h1}>OpenHistory</h1>
        <p style={styles.lead}>
          An open-source interactive atlas of human history. Scroll through history and learn
          the story of humankind.
        </p>

        <hr style={styles.rule} />

        <h2 style={styles.h2}>Data Sources</h2>

        <h3 style={styles.h3}>Events, Locations &amp; Polities — Wikipedia / Wikidata</h3>
        <p style={styles.p}>
          The ground truth for all events, locations, and political entities (polities) is{' '}
          <a style={styles.a} href="https://www.wikipedia.org" target="_blank" rel="noreferrer">Wikipedia</a> and its
          structured data layer,{' '}
          <a style={styles.a} href="https://www.wikidata.org" target="_blank" rel="noreferrer">Wikidata</a> (CC BY-SA).
          Our pipeline queries the Wikidata SPARQL API to fetch:
        </p>
        <ul style={styles.ul}>
          <li><strong>Events</strong> — battles, elections, treaties, disasters, discoveries, and more, each with a date and location</li>
          <li><strong>Locations</strong> — cities, regions, and countries referenced by events</li>
          <li><strong>Polities</strong> — kingdoms, empires, republics, colonies, viceroyalties, indigenous nations, peoples, and other political entities. They may have founding and dissolution dates and a capital, and can be assigned to a territory.</li>
        </ul>

        <h3 style={styles.h3}>Territory Polygons — historical-basemaps</h3>
        <p style={styles.p}>
          Territory boundaries (the shaded regions on the map) come from the open-source{' '}
          <a style={styles.a} href="https://github.com/aourednik/historical-basemaps" target="_blank" rel="noreferrer">historical-basemaps</a>{' '}
          project by A. Ourednik (GPL-3.0). It provides 53 hand-curated GeoJSON polygon snapshots
          spanning 100,000 BCE to 2010 CE. Territory polygons can be linked to a polity in our
          database — when linked, the shaded region and the polity marker refer to the same entity.
        </p>

        <p style={styles.p}>
          Instead of snapshots, OpenHistory supports year-level editing for borders. See below for instructions on how to edit borders.
        </p>

        <hr style={styles.rule} />

        <h2 style={styles.h2}>Contributing Data</h2>

        <h3 style={styles.h3}>Editing Events, Locations &amp; Polities</h3>
        <p style={styles.p}>
          When you correct a date or location for an event, location, or polity, that change is
          submitted <strong>directly to Wikidata</strong> — it improves the source data for everyone,
          not just OpenHistory. To make edits you need a free{' '}
          <a style={styles.a} href="https://www.mediawiki.org/wiki/Special:CreateAccount" target="_blank" rel="noreferrer">Wikipedia / Wikimedia account</a>.
          Click any event or polity on the map, then use the edit button in the info panel to
          log in and submit a correction.
        </p>

        <h3 style={styles.h3}>Mapping Territories to Polities</h3>
        <p style={styles.p}>
          Territory polygons and polities are linked by name-matching — but many territories
          haven't been matched yet and appear in <strong>grey</strong> on the map.
          You can help by mapping a grey territory to its polity:
        </p>
        <ol style={{ ...styles.ul, paddingLeft: 26 }}>
          <li>Click on a grey territory label on the map</li>
          <li>A panel will open — type the name of the corresponding polity</li>
          <li>Select the correct polity from the search results</li>
        </ol>
        <p style={styles.p}>
          No account required. Territory mappings are saved to the OpenHistory database and
          apply immediately.
        </p>

        <h3 style={styles.h3}>Editing Territory Boundaries</h3>
        <p style={styles.p}>
          Territory polygon shapes can be edited directly from the map. Click <strong>Edit Borders ✎</strong>{' '}
          in the top bar to enter the territory editor. In this mode:
        </p>
        <ul style={styles.ul}>
          <li>Drag any vertex to reshape a boundary</li>
          <li>Hover over an edge and click (or right-click) to insert a new vertex</li>
          <li>Right-click a vertex to delete it; or click to select it, then press Delete</li>
          <li>Press <strong>Ctrl+Z</strong> to undo any change</li>
          <li>Draw entirely new territory polygons with the <strong>+</strong> button</li>
        </ul>
        <p style={styles.p}>
          Shared borders between adjacent territories move together — editing one side
          automatically updates the neighbouring polygon. Changes are saved to the OpenHistory
          database. No account required.
        </p>

        <hr style={styles.rule} />

        <h2 style={styles.h2}>Open Source</h2>
        <p style={styles.p}>
          OpenHistory is fully open source under the MIT license. The code, pipeline, and data
          schema are all public.
        </p>
        <a
          style={styles.githubBtn}
          href="https://github.com/kdhillon/openhistory"
          target="_blank"
          rel="noreferrer"
        >
          View on GitHub
        </a>

        <h2 style={styles.h2}>Issues &amp; Contributions</h2>
        <p style={styles.p}>
          Found a data error or have a feature idea? Open an issue or pull request on{' '}
          <a style={styles.a} href="https://github.com/kdhillon/openhistory/issues" target="_blank" rel="noreferrer">GitHub</a>.
        </p>

        <hr style={styles.rule} />
        <p style={styles.footer}>
          Event &amp; polity data © <a style={styles.a} href="https://www.wikidata.org" target="_blank" rel="noreferrer">Wikidata</a> contributors (CC BY-SA) ·{' '}
          Territory polygons © <a style={styles.a} href="https://github.com/aourednik/historical-basemaps" target="_blank" rel="noreferrer">historical-basemaps</a> contributors (GPL-3.0) ·{' '}
          Map © <a style={styles.a} href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> ·{' '}
          Code © 2026 OpenHistory contributors (MIT) ·{' '}
          Created by <a style={styles.a} href="https://github.com/KDhillon" target="_blank" rel="noreferrer">Kyle Dhillon</a>
        </p>

      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#f8f9fa',
    display: 'flex',
    justifyContent: 'center',
    padding: '40px 20px 80px',
  },
  container: {
    maxWidth: 680,
    width: '100%',
  },
  header: {
    marginBottom: 32,
  },
  backBtn: {
    background: 'none',
    border: 'none',
    color: '#3366cc',
    fontSize: 14,
    cursor: 'pointer',
    padding: 0,
    fontFamily: 'inherit',
  },
  h1: {
    fontSize: 36,
    fontWeight: 700,
    color: '#202122',
    margin: '0 0 12px',
    letterSpacing: '-0.02em',
  },
  lead: {
    fontSize: 17,
    color: '#54595d',
    lineHeight: 1.6,
    margin: '0 0 16px',
  },
  statusBadge: {
    display: 'inline-block',
    background: '#fff3cd',
    border: '1px solid #ffc107',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 13,
    color: '#664d03',
    marginBottom: 24,
  },
  rule: {
    border: 'none',
    borderTop: '1px solid rgba(0,0,0,0.1)',
    margin: '28px 0',
  },
  h2: {
    fontSize: 22,
    fontWeight: 600,
    color: '#202122',
    margin: '28px 0 10px',
    letterSpacing: '-0.01em',
  },
  h3: {
    fontSize: 16,
    fontWeight: 600,
    color: '#202122',
    margin: '20px 0 8px',
  },
  p: {
    fontSize: 15,
    color: '#202122',
    lineHeight: 1.7,
    margin: '0 0 14px',
  },
  ul: {
    fontSize: 15,
    color: '#202122',
    lineHeight: 1.9,
    paddingLeft: 22,
    margin: '0 0 14px',
  },
  a: {
    color: '#3366cc',
    textDecoration: 'none',
  },
  githubBtn: {
    display: 'inline-block',
    background: '#202122',
    color: '#ffffff',
    padding: '9px 18px',
    borderRadius: 7,
    fontSize: 14,
    fontWeight: 600,
    textDecoration: 'none',
    marginBottom: 24,
  },
  footer: {
    fontSize: 13,
    color: '#54595d',
    lineHeight: 1.7,
    margin: 0,
  },
};
