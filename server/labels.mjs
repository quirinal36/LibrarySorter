// Reuse the catalogue-free label parser on the server; no books.json access.
import {detectLabels} from '../LibraryDetector/src/labels.mjs';
import {buildObservations} from '../LibraryDetector/src/recognition.mjs';
let input='';
for await (const chunk of process.stdin) input+=chunk;
const words=JSON.parse(input);
const data={blocks:[{paragraphs:[{lines:[{words}]}]}]};
const labels=detectLabels(data,[],{includeIncomplete:true}).slice(0,100);
process.stdout.write(JSON.stringify(buildObservations(labels)));
