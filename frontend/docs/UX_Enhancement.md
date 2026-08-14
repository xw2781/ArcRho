# User Interaction & Method Object Creation/Modifications

## Context Menu Design 
- In PI page, the right-click context menu in dataset table should show the related contents based on current highlighted dataset rows in table. 
- For example, DFM should only appear in the context menu "Create new method" (root level menu) -> "Development Factor Method" (2nd level menu) then the highlighted dataset is a triangle. Once new DFM setup window is open, auto fill the input triangle box, set default decimal place to 4 and let user finish the remaining boxes. 
- For other methods, similar logic should apply.  
- If multiple dataset rows are highlighted, the context menu targets the row where the mouse pointer completed the right-click action. If the right-click lands on a row outside the current selection, collapse the selection to that row so the highlight and the menu target always agree.
- When multiple rows are selected, emphasize the last selected row so the user knows which dataset will be opened once they hit the Enter key. All selected rows share the same background color fill; only the emphasized row keeps the solid blue bar on its left edge, while the other selected rows use a hollow (no-fill) bar instead of the solid style.

## Modify a Method
- If some key parameters like the origin/development length changed for a DFM method, then the downstream method such as RS should 'derive' the corresponding input to fit its (RS) shape. 
- For example, DFM changed from quarterly to annual shape, then it is still able to derive the cumulative development factors (CDF), but the factors are at the annual level. RS stay at quarterly level, and use 2025 CDF from new DFM, apply this annual CDF to 2025Q1,Q2,Q3,Q4 latest developed losses to get the new ultimate losses. In the opposite case, if DFM changed from quarterly to monthly shape, it should be much more intuitive to derive the new quarterly ultimates based on the monthly CDF and monthly loss triangle data. 
- The derivation is silent: after the user saves the DFM, the downstream RS json is updated automatically with the derived input, no extra confirmation step. Saving is the 1-step simple save; there is no 2-step plan & commit flow. 
- In the dataset UI table, setting the affected downstream methods' flag to "Needs Review" is sufficient to let the user know about the changes (e.g. changing a DFM length causes the input change in an RS). 
- The coarse-to-fine derivation (e.g. annual CDF applied to quarterly losses) is not a perfect interpolation. Refining it is future work; mixing granularities like an annual DFM feeding a quarterly RS is a very rare case and does not affect the current workflow. 

## Delete an Object
- Some methods are used as inputs for dependent methods, in this case, need to inform the user which downstream dataset(s) are currently using the dataset, 
- Don't let user delete upstream datasets until they manually drop/clear the input from all downstream datasets. In other words, only allow user delete a dataset who has no dependents. 
- When the user requests a delete, the engine checks whether the target dataset has dependents. If it does, pop up a window listing all dependents' names, each with a hyperlink that opens that downstream dataset's window so the user can review it and drop the target upstream dataset there (the way to drop it differs by each method object). 
- The delete procedure should be a job performed by data-engine running on the shared server, not frontend client app. 
