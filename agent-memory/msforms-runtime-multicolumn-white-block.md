---
name: msforms-runtime-multicolumn-white-block
description: An MSForms ListBox or ComboBox added with Controls.Add and then given ColumnCount > 1 draws a stray white block (~1.27x its size) over neighbouring controls under RDP display scaling; keep run-time lists single-column
metadata:
  node_type: memory
  type: project
  originSessionId: 6311e84e-f23c-4cb2-add1-9ec1624e1743
  modified: 2026-09-23T01:08:23.874Z
---

On 2026-09-22, building the Excel add-in's Insert Function panel (ufInsertFunction, controls built in code like ufAddinReferences), a two-column function ListBox left a white rectangle about 1.27x the list's size covering the labels beside and below it, every time the form opened. Two-column ComboBoxes on hidden pages also left a white patch while any dropdown was open.

**Why:** reproduced in a scratch form on NE7SASWPN02's RDP session: `Controls.Add("Forms.ListBox.1")` plus `ColumnCount = 2` / `ColumnWidths` shows the block; the same list without the column settings draws cleanly; nudging Width, hide/show, or re-sizing in Activate does not repair a two-column list. Designer-built multi-column lists (ufSelectDataset's lstNames) are unaffected. The ratio matches the session's display-scaling mismatch noted in [[desktop-input-control-works]].

**How to apply:** in any add-in form that creates lists at run time, keep them single-column; put a second fact in the item text instead (the panel uses "12 - Annual" and encodes the part before " - "). A quick probe loop: add a UserForm to a scratch .xlsm in a COM-driven visible Excel via `VBProject.VBComponents.Add(3)` and screenshot it; bind to the test workbook with `Marshal.BindToMoniker(path)`, never `GetActiveObject`, which grabs whichever Excel registered first (possibly the user's).
