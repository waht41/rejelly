---
# Redirect shell: locale homepages live at /en/ (default) and /zh/; the root only redirects.
# The head script runs during parse (before the 0s meta refresh fires at load) and routes by
# browser language: zh → /zh/, everything else → /en/. The meta refresh is the no-JS/crawler
# fallback and stays on the default /en/.
layout: page
title: Rejelly
head:
  - - script
    - {}
    - >-
      (function () {
      var lang = (navigator.languages && navigator.languages[0]) || navigator.language || "";
      var target = /^zh/i.test(lang) ? "/zh/" : "/en/";
      location.replace(target + location.search + location.hash);
      })();
  - - meta
    - http-equiv: refresh
      content: "0; url=/en/"
---

<div style="max-width: 640px; margin: 0 auto; padding: 6rem 1.5rem; text-align: center;">

Redirecting to the documentation… If nothing happens, continue to the [documentation](/en/) ([中文文档](/zh/)).

</div>
