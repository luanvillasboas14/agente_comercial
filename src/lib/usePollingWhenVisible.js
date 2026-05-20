import { useEffect, useRef } from 'react'

/**
 * Hook de polling que SÓ executa quando a aba está visível.
 * Quando o usuário troca de aba (document.hidden = true), pausa.
 * Quando volta, faz um fetch imediato e retoma o ciclo.
 *
 * @param {Function} callback função async (sem args). Recebe AbortSignal opcional via callback(signal)
 * @param {number} intervalMs intervalo em ms entre ticks. Default 60s.
 * @param {boolean} enabled se false, não inicia o polling. Útil pra desligar em pages sem foco.
 */
export function usePollingWhenVisible(callback, intervalMs = 60000, enabled = true) {
  const cbRef = useRef(callback)
  useEffect(() => { cbRef.current = callback }, [callback])

  useEffect(() => {
    if (!enabled) return

    let timerId = null
    let abortCtrl = null

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      abortCtrl?.abort()
      abortCtrl = new AbortController()
      Promise.resolve(cbRef.current?.(abortCtrl.signal)).catch(() => {})
    }

    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) tick()
    }

    timerId = setInterval(tick, intervalMs)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }

    return () => {
      if (timerId) clearInterval(timerId)
      abortCtrl?.abort()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }
  }, [intervalMs, enabled])
}
