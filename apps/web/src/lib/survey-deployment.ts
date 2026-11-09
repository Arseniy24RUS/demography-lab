/** The public questionnaire runs on a separate origin from the authenticated classroom. */
export interface SurveyDeployment {
  url: string;
  classroomOrigin: string;
}
export interface SurveyDeploymentResult {
  deployment: SurveyDeployment | null;
  error: string | null;
}
const allowedUrl = (url: URL) =>
  (url.protocol === 'https:' ||
    (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
  !url.username &&
  !url.password &&
  !url.search &&
  !url.hash;
export function validateSurveyDeployment(
  urlValue: unknown,
  classroomValue: unknown,
): SurveyDeploymentResult {
  if (!urlValue && !classroomValue) return { deployment: null, error: null };
  try {
    if (typeof urlValue !== 'string' || typeof classroomValue !== 'string')
      throw new Error('Укажите отдельный адрес формы опроса и адрес учебной платформы.');
    const url = new URL(urlValue),
      classroom = new URL(classroomValue);
    if (
      !allowedUrl(url) ||
      !url.pathname.endsWith('/survey.html') ||
      !allowedUrl(classroom) ||
      classroom.pathname !== '/'
    )
      throw new Error(
        'Для опроса нужен HTTPS-адрес survey.html, для платформы — HTTPS-origin без пути. Локально разрешён HTTP на loopback.',
      );
    if (url.origin === classroom.origin)
      throw new Error(
        'Форма опроса должна работать на отдельном origin, без хранилища учебной учётной записи.',
      );
    return { deployment: { url: url.href, classroomOrigin: classroom.origin }, error: null };
  } catch (cause) {
    return {
      deployment: null,
      error: cause instanceof Error ? cause.message : 'Некорректные адреса опроса.',
    };
  }
}
export const validSurveyId = (value: string) =>
  /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/iu.test(value);
export const validSurveySecret = (value: string) => /^[a-f\d]{64}$/u.test(value);
export function readSurveyInvitation(
  hash: string,
): { surveyId: string; invitationToken: string | null } | null {
  const values = new URLSearchParams(hash.replace(/^#/u, ''));
  const surveyId = values.get('survey') ?? '',
    token = values.get('invite');
  if (!validSurveyId(surveyId) || (token !== null && !validSurveySecret(token))) return null;
  return { surveyId, invitationToken: token };
}
export function surveyLink(deployment: SurveyDeployment, surveyId: string, token: string) {
  if (!validSurveyId(surveyId) || !validSurveySecret(token))
    throw new Error('Некорректное приглашение в опрос.');
  const url = new URL(deployment.url);
  url.hash = new URLSearchParams({ survey: surveyId, invite: token }).toString();
  return url.href;
}
export function assertSurveyOrigin(deployment: SurveyDeployment, currentUrl: string) {
  const current = new URL(currentUrl),
    expected = new URL(deployment.url);
  if (
    current.origin !== expected.origin ||
    current.origin === deployment.classroomOrigin ||
    current.pathname !== expected.pathname
  )
    throw new Error(
      'Откройте опрос по отдельной ссылке преподавателя. На адресе учебной платформы сбор личных ответов отключён.',
    );
}
