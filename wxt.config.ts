import { defineConfig } from 'wxt';
import { COPY } from './src/ui/copy';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: COPY.productName,
    description: COPY.productDescription,
    permissions: ['bookmarks', 'storage', 'activeTab', 'scripting'],
    host_permissions: ['https://api.typesafe.ai/*'],
    action: {
      default_title: COPY.actionTitle,
    },
  },
});
