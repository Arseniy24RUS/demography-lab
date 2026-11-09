import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Application render error', error.message, info.componentStack);
  }
  render() {
    if (this.state.failed)
      return (
        <main className="error-screen">
          <div className="error-box">
            <h1>Не удалось открыть рабочую область</h1>
            <p>
              Сохранённые данные остаются на устройстве. Перезагрузите страницу. Если ошибка
              повторяется, проверьте запуск через HTTP-сервер по инструкции проекта.
            </p>
            <button className="button button-primary" onClick={() => location.reload()}>
              Перезагрузить
            </button>
          </div>
        </main>
      );
    return this.props.children;
  }
}
