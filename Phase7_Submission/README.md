# Phase 7 submission: Deployment, Documentation & Presentation

| File | What it is |
|---|---|
| `FROSTMIND_Phase7_Documentation.docx` | Full project documentation (35 pages): architecture, hardware, firmware, phone app, backend, admin panel, AI models, deployment, usability, testing, demonstration plan, future scope, maintenance strategy, appendices |
| `FROSTMIND_Phase7_Documentation.pdf` | The same document as a PDF |
| `FROSTMIND_Phase7_Presentation.pptx` | 17-slide deck (16:9) with speaker notes on every slide |
| `figures/` | Diagrams used by both (architecture, deployment, wiring, light-strip workflow) |
| `source/` | The generators for everything above |

Before submitting, add the team members' names and roll numbers on the document's title page
(currently "Team FROSTMIND") and on slide 1.

## Regenerating

Edit the text in `source/doc_content.js` (document) or `source/build_pptx.js` (slides), then:

```
cd Phase7_Submission/source
npm install
node make_figures.js                                          # figures/*.png
node build_docx.js                                            # the .docx
powershell -ExecutionPolicy Bypass -File update_toc.ps1       # Word fills in the contents page + PDF
node build_pptx.js                                            # the .pptx
```

`update_toc.ps1` needs Microsoft Word. Without it, open the .docx and press F9 on the contents page.
