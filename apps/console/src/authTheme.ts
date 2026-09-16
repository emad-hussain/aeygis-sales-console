import type { Theme } from '@aws-amplify/ui-react';

/**
 * Amplify UI theme for the Authenticator — Porcelain direction.
 *
 * Only token paths confirmed against the Amplify UI docs and the installed
 * types are set here (fonts.default.*, radii.*, colors.border.*). Everything
 * else lives in brand.css as CSS custom properties scoped to
 * `[data-amplify-authenticator]`, which is the documented mechanism for what
 * a plain token cannot reach — the docs state that every design token is
 * exposed as an --amplify-* CSS variable and every component class is
 * prefixed `amplify-`.
 *
 * Deliberately reuses the SAME brand values as brand.css rather than
 * inventing a parallel palette — the Authenticator is the front door to the
 * same app, not a different product. Porcelain radii are generous, so the
 * Amplify fields have to be too or the form reads as pasted in from another
 * design.
 */
export const consoleAuthTheme: Theme = {
  name: 'aeygis-console-auth-theme',
  tokens: {
    fonts: {
      default: {
        variable: { value: "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
        static: { value: "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
      },
    },
    radii: {
      small: { value: '12px' },
      medium: { value: '12px' },
      large: { value: '14px' },
    },
    colors: {
      border: {
        primary: { value: '#ebe8e2' },
        secondary: { value: '#ddd9d0' },
        tertiary: { value: '#f1efeb' },
      },
    },
  },
};

/** Sign-in field copy. Cognito is configured for email login, so this
 * clarifies that rather than showing the generic "Username" Amplify default. */
export const authFormFields = {
  signIn: {
    username: {
      label: 'Work email',
      placeholder: 'you@aeygis.com',
      isRequired: true,
    },
    password: {
      label: 'Password',
      placeholder: 'Enter your password',
      isRequired: true,
    },
  },
};
