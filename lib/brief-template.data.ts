// FICHIER GÉNÉRÉ — ne pas éditer à la main.
// Source : lib/__tests__/fixtures/blank-template.xlsm (section EMAIL de la feuille "Campaign Brief").
// Régénérer : npm run extract:template
// Gardé par le test de boucle fermée lib/__tests__/brief-template.test.ts.

import type { BriefTemplateData } from "./brief-template";

export const EXTRACTED_TEMPLATE: BriefTemplateData = {
  "source": "lib/__tests__/fixtures/blank-template.xlsm",
  "channel": "EMAIL",
  "headerRow": 5,
  "fieldCol": 0,
  "descCol": 1,
  "valueCol": 2,
  "firstLangCol": 3,
  "languageColumns": [
    "EN",
    "IT",
    "FR",
    "ES",
    "MX",
    "PT",
    "JP",
    "KO",
    "ZHS",
    "ZHT",
    "TH"
  ],
  "languages": [
    {
      "code": "EN",
      "name": "English"
    },
    {
      "code": "IT",
      "name": "Italian"
    },
    {
      "code": "FR",
      "name": "French"
    },
    {
      "code": "ES",
      "name": "Spanish"
    },
    {
      "code": "MX",
      "name": "Spanish (Mexico)"
    },
    {
      "code": "PT",
      "name": "Portuguese"
    },
    {
      "code": "JP",
      "name": "Japanese"
    },
    {
      "code": "KO",
      "name": "Korean"
    },
    {
      "code": "ZHS",
      "name": "Simplified Chinese"
    },
    {
      "code": "ZHT",
      "name": "Traditional Chinese"
    },
    {
      "code": "TH",
      "name": "Thailand"
    }
  ],
  "preamble": [
    {
      "row": 0,
      "cells": [
        {
          "col": 0,
          "value": "EMAIL"
        }
      ]
    },
    {
      "row": 1,
      "cells": [
        {
          "col": 0,
          "value": "Campaign Name"
        },
        {
          "col": 1,
          "value": "ADHOC_GLOBAL_OTM_EMAIL_20260521_WFP_26_Series"
        }
      ]
    },
    {
      "row": 2,
      "cells": [
        {
          "col": 0,
          "value": "TARGET"
        }
      ]
    },
    {
      "row": 3,
      "cells": [
        {
          "col": 0,
          "value": "Target"
        },
        {
          "col": 1,
          "value": "Add target description here"
        }
      ]
    },
    {
      "row": 4,
      "cells": [
        {
          "col": 0,
          "value": "CONTENT DEFINITION"
        }
      ]
    }
  ],
  "fields": [
    {
      "key": "subject-line",
      "label": "Subject Line",
      "rowOffset": 1,
      "description": "Email subject",
      "master": "Dear [Name], discover…",
      "kind": "text",
      "required": true,
      "translatable": true
    },
    {
      "key": "subject-line-default-optional",
      "label": "Subject Line Default (optional)",
      "rowOffset": 2,
      "description": "",
      "master": "Dear client, discover…",
      "kind": "text",
      "required": false,
      "translatable": true
    },
    {
      "key": "preheader",
      "label": "Preheader",
      "rowOffset": 3,
      "description": "Preheader / preview text",
      "master": "Explore the latest arrivals →",
      "kind": "text",
      "required": true,
      "translatable": true
    },
    {
      "key": "headline",
      "label": "Headline",
      "rowOffset": 4,
      "description": "Main headline in the email body",
      "master": "Spring — Summer 2026",
      "kind": "text",
      "required": true,
      "translatable": true
    },
    {
      "key": "body-copy",
      "label": "Body Copy",
      "rowOffset": 5,
      "description": "Main copy in the email body",
      "master": "Short editorial paragraph…",
      "kind": "text",
      "required": true,
      "translatable": true
    },
    {
      "key": "cta-1-label",
      "label": "CTA 1 Label",
      "rowOffset": 6,
      "description": "Call-to-action button label",
      "master": "Shop Now",
      "kind": "text",
      "required": true,
      "translatable": true
    },
    {
      "key": "body-copy-2",
      "label": "Body Copy 2",
      "rowOffset": 7,
      "description": "Main copy in the email body",
      "master": "Short editorial paragraph…",
      "kind": "text",
      "required": true,
      "translatable": true
    },
    {
      "key": "cta-2-label",
      "label": "CTA 2 Label",
      "rowOffset": 8,
      "description": "Call-to-action button label",
      "master": "Shop Now",
      "kind": "text",
      "required": true,
      "translatable": true
    },
    {
      "key": "hero-asset-url",
      "label": "Hero Asset URL",
      "rowOffset": 9,
      "description": "Key Visual redirection",
      "master": "https://brand.com/new-collection",
      "kind": "url",
      "required": true,
      "translatable": false
    },
    {
      "key": "cta-1-url",
      "label": "CTA 1 URL",
      "rowOffset": 10,
      "description": "Call-to-action destination URL",
      "master": "https://brand.com/new-collection",
      "kind": "url",
      "required": true,
      "translatable": false
    },
    {
      "key": "packshots-1-url",
      "label": "Packshots 1 URL",
      "rowOffset": 11,
      "description": "Packshot Redirection",
      "master": "https://brand.com/875638sn479",
      "kind": "url",
      "required": true,
      "translatable": false
    },
    {
      "key": "packshots-2-url",
      "label": "Packshots 2 URL",
      "rowOffset": 12,
      "description": "Packshot Redirection",
      "master": "https://brand.com/875638sn479",
      "kind": "url",
      "required": true,
      "translatable": false
    },
    {
      "key": "cta-2-url-women",
      "label": "CTA 2 URL - WOMEN",
      "rowOffset": 13,
      "description": "Call-to-action destination URL",
      "master": "https://brand.com/new-collection",
      "kind": "url",
      "required": true,
      "translatable": false
    },
    {
      "key": "cta-2-url-men",
      "label": "CTA 2 URL - MEN",
      "rowOffset": 14,
      "description": "Call-to-action destination URL",
      "master": "https://brand.com/new-collection",
      "kind": "url",
      "required": true,
      "translatable": false
    },
    {
      "key": "mock-up",
      "label": "Mock Up",
      "rowOffset": 16,
      "description": "Visual reference for the template structure",
      "master": "",
      "kind": "meta",
      "required": false,
      "translatable": false
    }
  ]
} as const;
