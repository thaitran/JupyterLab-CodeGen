import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

/**
 * Initialization data for the jupyterlab_codegen extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_codegen:plugin',
  description: 'JupyterLab extension that can generate code using GPT-4 (similar to ChatGPT's Code Interpreter)',
  autoStart: true,
  activate: (app: JupyterFrontEnd) => {
    console.log('JupyterLab extension jupyterlab_codegen is activated!');
  }
};

export default plugin;
