import type { Theme as VitePressTheme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import "./style.css";

const theme: VitePressTheme = {
  extends: DefaultTheme,
  Layout: () => {
    return h(DefaultTheme.Layout, null, {
      // https://vitepress.dev/guide/extending-default-theme#layout-slots
    });
  },
  enhanceApp({ app: _app, router: _router, siteData: _siteData }) {
    // ...
  },
};

export default theme;
