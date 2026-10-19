import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'uk.gbrouter.app',
  appName: 'GBRouter',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
};

export default config;
