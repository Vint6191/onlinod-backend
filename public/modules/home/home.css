/* modules/home/renderer/home.css */

.hq-hero-card,
.hq-panel,
.hq-todo-section,
.hq-todo-card {
border-radius: 16px;
  background: var(--on-panel);
  border: 1px solid var(--on-line);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.025),
    0 18px 44px rgba(0, 0, 0, 0.25);
  backdrop-filter: blur(38px);
  -webkit-backdrop-filter: blur(38px);
}

.hq-hero-card {
position: relative;
  padding: 18px 22px 20px;
  margin-bottom: 12px;
  overflow: hidden;
}

.hq-hero-card::before {
content: "";
  position: absolute;
  top: -90px;
  right: -90px;
  width: 340px;
  height: 340px;
  border-radius: 999px;
  background: radial-gradient(circle, rgba(251, 191, 36, 0.16), transparent 66%);
  pointer-events: none;
}

.hq-terminal-line {
position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 16px;
  font-family: var(--on-mono);
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
}

.hq-terminal-line em {
color: rgba(255, 255, 255, 0.3);
  font-style: normal;
}

.hq-terminal-spacer {
flex: 1;
}

.hq-window-dots {
display: flex;
  gap: 5px;
}

.hq-window-dots span {
width: 7px;
  height: 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
}

.hq-window-dots span.active {
background: var(--on-amber);
  box-shadow: 0 0 7px rgba(251, 191, 36, 0.75);
}

.hq-metrics-grid {
position: relative;
  display: grid;
  grid-template-columns: 1.2fr 0.9fr 0.9fr 0.8fr;
  gap: 24px;
  align-items: end;
}

.hq-metric-label {
margin-bottom: 10px;
  color: rgba(255, 255, 255, 0.42);
  font-family: var(--on-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-weight: 700;
}

.hq-metric-value {
color: var(--on-text);
  font-size: 36px;
  font-weight: 250;
  line-height: 1;
  letter-spacing: -0.045em;
}

.hq-metric:first-child .hq-metric-value {
font-size: 46px;
}

.hq-metric-hint {
margin-top: 10px;
  color: var(--on-muted);
  font-family: var(--on-mono);
  font-size: 11px;
}

.hq-metric.ok .hq-metric-hint {
display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  color: var(--on-green);
  background: rgba(134, 239, 172, 0.1);
  border: 1px solid rgba(134, 239, 172, 0.28);
  font-weight: 800;
}

.hq-metric.warn .hq-metric-hint {
color: var(--on-amber);
}

.hq-sparkline {
position: relative;
  width: 100%;
  height: 38px;
  margin-top: 18px;
  display: block;
}

/* home layout */

.hq-home-grid {
display: grid;
  grid-template-columns: 1.35fr 1fr;
  gap: 12px;
  margin-bottom: 12px;
}

.hq-panel {
padding: 16px 18px;
}

.hq-panel-head {
display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.hq-panel-title {
color: rgba(255, 255, 255, 0.58);
  font-family: var(--on-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-weight: 800;
}

.hq-panel-subtitle {
margin-top: 4px;
  color: rgba(255, 255, 255, 0.35);
  font-family: var(--on-mono);
  font-size: 11px;
}

.hq-link-btn {
background: transparent;
  color: var(--on-amber);
  font-family: var(--on-mono);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
}

.hq-creator-list {
display: flex;
  flex-direction: column;
}

.hq-creator-row {
display: flex;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  padding: 10px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.055);
  cursor: pointer;
}

.hq-creator-row:hover {
background: rgba(255, 255, 255, 0.018);
}

.hq-creator-row.warning {
border-left: 2px solid var(--on-amber);
  margin-left: -18px;
  padding-left: 16px;
}

.hq-creator-avatar {
width: 32px;
  height: 32px;
  border-radius: 9px;
  object-fit: cover;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  font-family: var(--on-mono);
  color: #0a0715;
  font-size: 11px;
  font-weight: 900;
  background: linear-gradient(135deg, var(--on-amber), var(--on-amber-2));
  border: 1px solid rgba(251, 191, 36, 0.24);
}

.hq-creator-avatar.fallback {
color: #0a0715;
}

.hq-creator-main {
flex: 1;
  min-width: 0;
}

.hq-creator-name {
color: #fafafa;
  font-size: 12px;
  font-weight: 700;
}

.hq-creator-meta {
margin-top: 3px;
  color: rgba(255, 255, 255, 0.45);
  font-family: var(--on-mono);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hq-live-pill {
display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 999px;
  color: var(--on-green);
  border: 1px solid rgba(134, 239, 172, 0.3);
  background: rgba(134, 239, 172, 0.08);
  font-family: var(--on-mono);
  font-size: 11px;
  font-weight: 800;
}

.hq-live-pill::before {
content: "";
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--on-green);
  box-shadow: 0 0 7px rgba(134, 239, 172, 0.8);
}

.hq-resolve-btn {
height: 24px;
  padding: 0 10px;
  border-radius: 6px;
  color: #0a0715;
  background: var(--on-amber);
  font-family: var(--on-mono);
  font-size: 11px;
  font-weight: 800;
  cursor: pointer;
}

/* audit */

.hq-audit-list {
display: flex;
  flex-direction: column;
  gap: 12px;
}

.hq-audit-row {
display: flex;
  gap: 10px;
}

.hq-audit-row > span {
min-width: 42px;
  flex-shrink: 0;
  padding-top: 1px;
  color: rgba(255, 255, 255, 0.38);
  font-family: var(--on-mono);
  font-size: 11px;
}

.hq-audit-row b {
display: inline;
  color: #fafafa;
  font-size: 12px;
  font-weight: 650;
}

.hq-audit-row em {
display: block;
  margin-top: 3px;
  color: rgba(255, 255, 255, 0.45);
  font-family: var(--on-mono);
  font-size: 11px;
  font-style: normal;
}

/* todo cards */

.hq-todo-grid {
display: grid;
  grid-template-columns: repeat(4, minmax(160px, 1fr));
  gap: 12px;
}

.hq-todo-card {
padding: 16px;
}

.hq-todo-top {
display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.hq-todo-title {
color: #fafafa;
  font-size: 13px;
  font-weight: 750;
}

.hq-todo-subtitle {
margin-top: 5px;
  color: var(--on-muted);
  font-size: 12px;
  line-height: 1.45;
}

.hq-todo-top span,
.hq-todo-badge {
flex-shrink: 0;
  padding: 5px 8px;
  border-radius: 999px;
  color: var(--on-amber);
  background: rgba(251, 191, 36, 0.1);
  border: 1px solid rgba(251, 191, 36, 0.22);
  font-family: var(--on-mono);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.08em;
}

.hq-todo-section {
padding: 18px 22px 22px;
}

.hq-todo-section-main {
display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 18px;
}

.hq-page-title {
color: var(--on-text);
  font-size: 34px;
  font-weight: 250;
  letter-spacing: -0.04em;
}

.hq-page-subtitle {
margin-top: 8px;
  max-width: 680px;
  color: var(--on-muted);
  font-size: 13px;
  line-height: 1.55;
}

.hq-empty {
min-height: 90px;
  display: grid;
  place-items: center;
  color: var(--on-muted);
  font-size: 12px;
}

#homeMount{min-width:0}
.hq-link-btn,.hq-resolve-btn,.hq-todo-top span,.hq-todo-badge{border:0}
.hq-resolve-btn{display:inline-flex;align-items:center}
@media(max-width:980px){.hq-metrics-grid,.hq-home-grid,.hq-todo-grid{grid-template-columns:1fr}}
