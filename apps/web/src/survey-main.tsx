import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ParticipantSurveyContainer } from './components/ParticipantSurveyContainer';
import './styles.css';
import './session.css';
import './barriers.css';

/** The anonymous entry never loads the classroom, Auth SDK, account errors or analytics. */
class SurveyBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="error-screen">
        <h1>Не удалось открыть анкету</h1>
        <p>
          Сохраните личную квитанцию, если она уже получена, и обновите страницу. Неотправленный
          текст потребуется ввести повторно.
        </p>
        <button className="button button-primary" onClick={() => location.reload()}>
          Обновить страницу
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SurveyBoundary>
      <ParticipantSurveyContainer />
    </SurveyBoundary>
  </StrictMode>,
);
