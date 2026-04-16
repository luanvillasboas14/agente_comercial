import { Search, Sparkles, ChevronRight } from 'lucide-react'

export default function Sidebar({ prompts, selected, onSelect, filter, onFilter, loading }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="logo">
          <div className="logo-icon">
            <Sparkles size={20} />
          </div>
          <div>
            <h1 className="logo-title">Agente Comercial</h1>
            <span className="logo-sub">Prompts da IA</span>
          </div>
        </div>
      </div>

      <div className="sidebar-search">
        <Search size={16} className="search-icon" />
        <input
          type="text"
          placeholder="Buscar prompt..."
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
        />
      </div>

      <div className="sidebar-section">
        <span className="section-label">Prompts</span>
        <span className="section-count">{prompts.length}</span>
      </div>

      <nav className="sidebar-nav">
        {loading && (
          <div className="nav-empty">
            <div className="loader-sm" />
          </div>
        )}
        {!loading && prompts.length === 0 && (
          <div className="nav-empty">Nenhum encontrado</div>
        )}
        {prompts.map((p) => (
          <button
            key={p.id}
            className={`nav-item ${selected === p.id ? 'active' : ''}`}
            onClick={() => onSelect(p.id)}
          >
            <div className="nav-item-content">
              <span className="nav-item-name">{p.name}</span>
              <span className="nav-item-type">{p.type}</span>
            </div>
            <ChevronRight size={14} className="nav-item-arrow" />
          </button>
        ))}
      </nav>
    </aside>
  )
}
