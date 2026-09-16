import { useTheme } from './useTheme';

/**
 * Light/dark switch.
 *
 * Shows the icon for the theme it will switch TO, which is the convention
 * users already read correctly — a moon means "go dark", not "you are dark".
 * The accessible name says the same thing in words, because an icon alone
 * cannot disambiguate that.
 *
 * Icons are inline SVG rather than an icon package: two glyphs do not justify
 * a dependency, and `currentColor` means they follow the button's own state
 * without a second set of theme rules.
 */
export function ThemeToggle() {
  const { theme, choice, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      className="ghost theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={
        choice === null
          ? `Following your system theme (${theme}). Switch to ${next}.`
          : `Switch to ${next} theme`
      }
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
      <path
        d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2M6.5 6.5 4.9 4.9M19.1 19.1l-1.6-1.6M17.5 6.5l1.6-1.6M4.9 19.1l1.6-1.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
