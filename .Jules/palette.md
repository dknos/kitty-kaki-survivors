## 2026-05-16 - Custom Select/Slider Form Accessibility
**Learning:** In a codebase generating form controls dynamically with document.createElement, it is easy to miss associating text labels with inputs. Using a plain span as a label breaks accessibility.
**Action:** When creating form rows with controls and labels, generate a unique random string ID for the input and map a <label> element with htmlFor to programmatically associate them for screen readers.
