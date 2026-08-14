# User Interaction & Method Object Creation/Modifications

## Context Menu Design
- In PI page, the right-click context menu in dataset table should show the related contents based on current highlighted dataset rows in table.
- For example, DFM should only appear in the context menu "Create new method" (root level menu) -> "Development Factor Method" (2nd level menu) then the highlighted dataset is a triangle. Once new DFM setup window is open, auto fill the input triangle box, set default decimal place to 4 and let user finish the remaining boxes.
- For other methods, similar logic should apply.

## Delete an Object
- Some methods are used as inputs for dependent methods, in this case, need to inform the user which downstream dataset(s) are currently using the dataset.
- Don't let user delete upstream datasets until they manually drop/clear the input from all downstream datasets. In other words, only allow user delete a dataset who has no dependents.
- The delete procedure should be a job performed by data-engine running on the shared server, not frontend client app.
