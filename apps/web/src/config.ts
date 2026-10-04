/**
 * Public configuration. None of these values is a secret: the browser sends
 * the client id and the Cognito URLs on every sign-in anyway. Build-time
 * VITE_* variables override them (local development uses dev auth and a
 * local API).
 */
const env = import.meta.env;

export const config = {
  apiUrl: (env.VITE_API_URL as string | undefined) ?? 'https://prepress-api.gemsofy.com',
  authMode: ((env.VITE_AUTH_MODE as string | undefined) ?? 'cognito') as 'cognito' | 'dev',
  cognito: {
    authority: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_7tJiVQyxr',
    clientId: '5f7f65ah7brd3a1fgnl28a6n9s',
    domain: 'https://us-east-17tjivqyxr.auth.us-east-1.amazoncognito.com',
  },
  maxUploadBytes: 200 * 1024,
};
