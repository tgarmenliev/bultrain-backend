import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { useTheme, type ThemePref } from '../theme';

const OPTIONS: { value: ThemePref; label: string; Icon: LucideIcon }[] = [
    { value: 'system', label: 'Като системата', Icon: Monitor },
    { value: 'light', label: 'Светла тема', Icon: Sun },
    { value: 'dark', label: 'Тъмна тема', Icon: Moon },
];

export default function ThemeToggle() {
    const { pref, setPref } = useTheme();
    return (
        <div role="radiogroup" aria-label="Тема" className="segmented">
            {OPTIONS.map(({ value, label, Icon }) => (
                <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={pref === value}
                    aria-label={label}
                    title={label}
                    onClick={() => setPref(value)}
                >
                    <Icon size={15} strokeWidth={2} aria-hidden="true" />
                </button>
            ))}
        </div>
    );
}
