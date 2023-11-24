import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ToolbarButton, InputDialog, showErrorMessage } from '@jupyterlab/apputils';
import OpenAI from 'openai';

const debug = false;

const model = 'gpt-4-1106-preview';

var apiKey = '';

var openai : OpenAI;

const systemMessage = `
You are Code Interpreter, a world-class programmer that can complete any goal by executing code.
First, write a plan.
When you send a message containing code to run_code, it will be executed **on the user's machine**. The user has given you **full and complete permission** to execute any code necessary to complete the task. You have full access to control their computer to help them. Code entered into run_code will be executed **in the users local environment**.
Only use the function you have been provided with, run_code.
You can access the internet. Run **any code** to achieve the goal, and if at first you don't succeed, try again and again.
You can install new packages with pip for python. Try to install all necessary packages in one command at the beginning.
Put a ! in front of all shell commands as they will be run from within a Jupyter notebook.
When a user refers to a filename, they're likely referring to an existing file in the directory you're currently in (run_code executes on the user's machine).
In general, choose packages that have the most universal chance to be already installed and to work across multiple applications. Packages like ffmpeg and pandoc that are well-supported and powerful.
Write messages to the user in Markdown.
In general, try to **make plans** with as few steps as possible. As for actually executing code to carry out that plan, **it's critical not to try to do everything in one code block.** You should try something, print information about it, then continue from there in tiny, informed steps. You will never get it on the first try, and attempting it in one go will often lead to errors you cant see.
You are capable of **any** task.
`;

// Define the schema for the run_code function
const functionSchema : OpenAI.Chat.ChatCompletionCreateParams.Function[] = [
  {
    name: "run_code",
    description: "Executes code on the user's machine and returns the output",
    parameters: {
      type: "object",
      properties: {
        language: {
          type: "string",
          description: "The programming language",
          enum: ["python", "shell"]
        },
        code: {
          type: "string",
          description: "The code to execute"
        }
      },
      required: ["language", "code"]
    }
}];

// OpenAI sometimes returns newlines in JSON strings rather than \n
// Clean this so that it can be parsed as JSON
function cleanJson(origJson: string): string {
  var cleanedJson = "";

  var inQuotes = false;
  for (let i = 0; i < origJson.length; i++) {
    if (origJson[i] == '"') {
      inQuotes = !inQuotes;
    }
    if (origJson[i] == '\n' && inQuotes) {
      cleanedJson += "\\n";
    } else {
      cleanedJson += origJson[i];
    }
  }

  return cleanedJson;
}

// Convert the outputs (including error messages) from a code cell into a single string
function parseCellOutput(outputs: Array<any>): string {
    var extractedOutput = "";

    if (outputs) {
      for (const output of outputs) {
        if (typeof output === 'object') {
          if (output) {

            if ('text' in output) {
              extractedOutput += output.text?.toString() || "";
            }

            if ('data' in output) {
              if (output.data && typeof output.data === 'object') {
                if ('text/plain' in output.data) {
                  extractedOutput += output.data['text/plain']?.toString() || "";
                }
              }
            }

            if ('ename' in output) {
              extractedOutput += output.ename + ": " + output.evalue;
            }

          }
        }
      }
    }

    return extractedOutput;
}

// Define the JupyterLab Code Interpreter extension
const extension: JupyterFrontEndPlugin<void> = {
  id: 'Code Interpreter',
  autoStart: true,
  requires: [INotebookTracker],
  activate: activateCodeInterpreter
};

function activateCodeInterpreter(app: JupyterFrontEnd, tracker: INotebookTracker): void {
  console.log("Code Interpreter extension activated!");

  var interpreterRunningCode = false;
  var userRequestedStopGeneration = false;

  // Convert cells from the top of the notebook to the active cell into OpenAI messages
  function convertNotebookToMessages() {
    if (tracker.currentWidget) {
      const notebook = tracker.currentWidget.content;
      const activeCellIndex = notebook.activeCellIndex;

      // Start with the system message
      var messages : Array<OpenAI.Chat.ChatCompletionMessageParam> = [
        { role: 'system', content: systemMessage }
      ];
    
      for (let i = 0; i <= activeCellIndex; i++) {
        const cell = notebook.model?.cells.get(i);
        if (cell) {
          const json = cell.toJSON();
          const cellType = json.cell_type;
          const source = json.source.toString();

          if (cellType == 'markdown') {
            if (source.startsWith('__Assistant:__')) {
              // Markdown cells that begin __Assistant:__ are added as assistant messages
              const assistantContent = source.replace(/^__Assistant:__\s*/, '');
              messages.push({ role: 'assistant', content: assistantContent });
            } else {
              // All other markdown cells are added as user messages
              messages.push({ role: 'user', content: source });
            }
          } else if (cellType == 'code') {
            const outputs = json?.outputs;
            var functionOutput = "";
            
            if (outputs && Array.isArray(outputs)) {
               functionOutput = parseCellOutput(outputs);
            }

            if (functionOutput) {
              var lastMessage = messages[messages.length-1];

              if (lastMessage.role == "assistant") {
                // If the last message was from the assistant, assume the code was a function call
                lastMessage.function_call = {
                  name: 'run_code',
                  arguments: JSON.stringify({ language: "python", code: source }),
                }

                messages.push({ role: "function", name: "run_code", content: functionOutput });
                continue;
              }
            }

            // Otherwise, add it as a user message in a fenced code block
            messages.push({ role: "user", content: "```\n" + source + "\n```Output:\n" + functionOutput });       
          }
        }
      }

      if (debug) {
        console.log(messages);
      }
      return messages;
    }
  };

  // Call OpenAI to generate code based on the current notebook and prompt
  async function generateCompletion() {
    const messages = convertNotebookToMessages();
    if (!messages) {
      return;
    }

    app.commands.execute('notebook:insert-cell-below');
    app.commands.execute('notebook:change-cell-to-markdown');
    await tracker.activeCell?.ready;

    app.commands.execute('notebook:replace-selection', { text: "__Assistant:__\n" });

    try {
      const stream = await openai.chat.completions.create({
        model: model,
        messages: messages,
        functions: functionSchema,
        function_call: 'auto',
        stream: true,
      });

      var inFunctionCall = false;

      var allContent = "";
      var allFunctionArguments = "";

      for await (const part of stream) {
        if (userRequestedStopGeneration) {
          // Abort if the user pressed the "Stop Generating" button
          userRequestedStopGeneration = false;
          return;
        }

        const functionCall = part.choices[0]?.delta?.function_call || ''
          
        if (!inFunctionCall && functionCall) {
          // If OpenAI returned a function call, then run the markdown cell
          // with the Assistant's prior message and then create a new code cell
          // for the functon call
          inFunctionCall = true;

          app.commands.execute('notebook:run-cell-and-insert-below');
          await tracker.activeCell?.ready;
          
          app.commands.execute('notebook:replace-selection', { text: "# Generating code...\n" });
        }

        if (inFunctionCall) {
          // Accumulate the function call arguments
          // (We don't stream the function call to the code cell because user input
          // during streaming can cause the code to be invalid)
          if (typeof functionCall == 'object') {
            var code = functionCall.arguments;

            // \r\n seems to cause problems for JupyterLab
            if (code == "\r\n") {
              code = "\n";
            }

            allFunctionArguments += code;
          }
        } else {
          // Stream the assistant's messages to the markdown cell
          const content = part.choices[0]?.delta?.content || ''
          app.commands.execute('notebook:replace-selection', { text: content });

          allContent += content;
        }
      }

      var assistantMessage : OpenAI.Chat.ChatCompletionMessageParam = {
        role: 'assistant',
        content: allContent
      };

      if (allFunctionArguments) {
        // Execute the function call in a code cell

        /*
        // Remove the "Generating code..." message
        app.commands.execute('notebook:delete-cell');
        app.commands.execute('notebook:insert-cell-below');
        app.commands.execute('notebook:change-cell-to-code');
        await tracker.activeCell?.ready;
        */

        allFunctionArguments = cleanJson(allFunctionArguments);

        if (allFunctionArguments.startsWith('{')) {
          const json = JSON.parse(allFunctionArguments);
          if ('code' in json) {
            app.commands.execute('notebook:replace-selection', { text: json.code });
          }
        } else {
          // OpenAI sometimes returns Python code rather than the run_code function arguments
          app.commands.execute('notebook:replace-selection', { text: allFunctionArguments });
        }

        assistantMessage.function_call = {
          name: 'run_code',
          arguments: allFunctionArguments
        };

        interpreterRunningCode = true;
        app.commands.execute('notebook:run-cell');

      } else {
        // Assistant did not return a function call -- so we're done
        interpreterRunningCode = false;
        stopGeneratingButton.hide();
        generateCodeButton.show();

        app.commands.execute('notebook:run-cell');
        app.commands.execute('notebook:insert-cell-below');
      }
    } catch (error) {
      if (error != null && typeof error === 'object') {
        showErrorMessage('Error', error.toString());

        // Clear the API key if it's invalid
        if (error.toString().includes("API key")) {
          apiKey = "";
        }
      }

      interpreterRunningCode = false;
      stopGeneratingButton.hide();
      generateCodeButton.show();
    }
  };

  // When a code cell has completed running, we check whether we're in the middle
  // of generating code.  If so, we generate the next step.
  tracker.currentChanged.connect(() => {
    const currentNotebook = tracker.currentWidget;
    if (currentNotebook) {
      currentNotebook.context.sessionContext.statusChanged.connect((_, status) => {
        if (status == 'idle' && interpreterRunningCode) {
          generateCompletion();
        }
      });
    }
  });

  // Start code generation based on the notebook and prompt in the active cell
  async function startGeneratingCode() {
    if (apiKey == "") {
      await InputDialog.getText({ title: 'Please enter your OpenAI API key' }).then(value => {
        apiKey = value.value || '';
      });
    }

    if (apiKey == "") {
      await showErrorMessage('OpenAI API Key Required', 'You need an OpenAI API key to use this extension.  You can obtain one from https://platform.openai.com/account/api-keys');

      interpreterRunningCode = false;
      stopGeneratingButton.hide();
      generateCodeButton.show();
      return;
    }

    openai = new OpenAI({
      apiKey: apiKey,
      dangerouslyAllowBrowser: true
    });

    const current = tracker.currentWidget;
    const json = current?.content.activeCell?.model.toJSON();
    const source = json?.source;

    const notebook = tracker.currentWidget?.content;
    console.log("startGeneratingCode: activeCell=" + notebook?.activeCellIndex);

    if (!source) {
      showErrorMessage("Prompt Required", "Please enter a prompt in the current cell for the code you would like GPT-4 to generate.  For example:  Print the first 10 Fibonacci numbers");
      return;
    }
    app.commands.execute('notebook:change-cell-to-markdown');
    app.commands.execute('notebook:run-cell');
    await tracker.activeCell?.ready;

    generateCodeButton.hide();
    stopGeneratingButton.show();

    generateCompletion();
  };

  // Stop generating code
  function stopGeneratingCode() {
    userRequestedStopGeneration = true;
    interpreterRunningCode = false;
    stopGeneratingButton.hide();
    generateCodeButton.show();
  };
  
  // Setup toolbar buttons
  const generateCodeButton = new ToolbarButton({
    className: 'generateCodeButton',
    label: 'Generate Code',
    onClick: startGeneratingCode,
    tooltip: 'Generate code from the current notebook'
  });

  const stopGeneratingButton = new ToolbarButton({
    className: 'stopGeneratingButton',
    label: 'Stop Generating',
    onClick: stopGeneratingCode,
    tooltip: 'Stop generating code'
  });

  const dumpNotebookButton = new ToolbarButton({
    className: 'dumpBotebookButton',
    label: 'Dump Notebook',
    onClick: convertNotebookToMessages,
    tooltip: 'Dump entire contents of notebook to console'
  });

  tracker.widgetAdded.connect((sender, notebookPanel) => {
    notebookPanel.toolbar.insertItem(10, 'generateCode', generateCodeButton);
    notebookPanel.toolbar.insertItem(11, 'stopGenerating', stopGeneratingButton);
    stopGeneratingButton.hide();

    if (debug) {
      notebookPanel.toolbar.insertItem(12, 'dumpNotebook', dumpNotebookButton);
    }
  });
  
}

export default extension;

// Note:  Complete list of JupyterLab commands are here: https://github.com/jupyterlab/jupyterlab/blob/main/packages/notebook-extension/src/index.ts
