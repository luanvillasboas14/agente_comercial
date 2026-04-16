import { Sparkles, FileText, FlaskConical } from 'lucide-react'

const NAV_ITEMS = [
  { id: 'prompts', label: 'Prompts', icon: FileText },
  { id: 'playground', label: 'Teste IA', icon: FlaskConical },
]

export default function Sidebar({ page, onNavigate }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="logo">
          <div className="logo-icon">
            <Sparkles size={20} />
          </div>
          <div>
            <h1 className="logo-title">Agente Comercial</h1>
            <span className="logo-sub">Painel da IA</span>
          </div>
        </div>
      </div>

      <div className="sidebar-section">
        <span className="section-label">Menu</span>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item ${page === id ? 'active' : ''}`}
            onClick={() => onNavigate(id)}
          >
            <Icon size={18} className="nav-item-icon" />
            <span className="nav-item-label">{label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <span className="sidebar-version">v1.0</span>
      </div>
    </aside>
  )
}
