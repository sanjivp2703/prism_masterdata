import type { Metadata } from 'next';
import SettingsClient from './SettingsClient';

export const metadata: Metadata = {
  title: 'Settings · Prism',
};

export default function SettingsPage() {
  return <SettingsClient />;
}
