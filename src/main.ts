import './ui/styles.css';
import { App } from './ui/app.ts';

const root = document.getElementById('app');
if (!root) throw new Error('#app is missing from index.html');

const app = new App(root);
void app.start();
