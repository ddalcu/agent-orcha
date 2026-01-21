/**
 * Agent Orcha - Code Copy Functionality
 * Handles copy-to-clipboard for code blocks
 */

(function() {
  'use strict';

  // ========== Copy to Clipboard ==========
  function copyToClipboard(text) {
    // Modern approach using Clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }

    // Fallback for older browsers
    return new Promise(function(resolve, reject) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.top = '0';
      textarea.style.left = '0';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);

      try {
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);

        const successful = document.execCommand('copy');
        document.body.removeChild(textarea);

        if (successful) {
          resolve();
        } else {
          reject(new Error('Copy command failed'));
        }
      } catch (err) {
        document.body.removeChild(textarea);
        reject(err);
      }
    });
  }

  // ========== Initialize Copy Buttons ==========
  function initCopyButtons() {
    const copyButtons = document.querySelectorAll('.code-copy-btn');

    copyButtons.forEach(function(button) {
      button.addEventListener('click', function() {
        const targetId = button.getAttribute('data-copy-target');
        let textToCopy = '';

        if (targetId) {
          // Copy from specific target element
          const targetElement = document.getElementById(targetId);
          if (targetElement) {
            textToCopy = targetElement.textContent || targetElement.innerText;
          }
        } else {
          // Copy from sibling code block
          const codeBlock = button.closest('.code-block');
          if (codeBlock) {
            const codeContent = codeBlock.querySelector('.code-content code, .code-content pre');
            if (codeContent) {
              textToCopy = codeContent.textContent || codeContent.innerText;
            }
          }
        }

        // Trim whitespace
        textToCopy = textToCopy.trim();

        if (textToCopy) {
          // Copy to clipboard
          copyToClipboard(textToCopy)
            .then(function() {
              // Show success feedback
              showCopyFeedback(button, true);
            })
            .catch(function(err) {
              console.error('Failed to copy:', err);
              // Show error feedback
              showCopyFeedback(button, false);
            });
        }
      });
    });
  }

  // ========== Show Copy Feedback ==========
  function showCopyFeedback(button, success) {
    const originalText = button.textContent;

    if (success) {
      button.textContent = 'Copied!';
      button.classList.add('copied');
    } else {
      button.textContent = 'Failed';
    }

    // Reset after 2 seconds
    setTimeout(function() {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 2000);
  }

  // ========== Add Copy Buttons to Code Blocks ==========
  function addCopyButtonsToCodeBlocks() {
    // Find code blocks without copy buttons
    const codeBlocks = document.querySelectorAll('.code-block:not(.has-copy-btn)');

    codeBlocks.forEach(function(codeBlock) {
      // Check if it already has a header with copy button
      let header = codeBlock.querySelector('.code-header');

      if (!header) {
        // Create header if it doesn't exist
        header = document.createElement('div');
        header.className = 'code-header';

        const language = document.createElement('span');
        language.className = 'code-language';
        language.textContent = 'Code';

        header.appendChild(language);
        codeBlock.insertBefore(header, codeBlock.firstChild);
      }

      // Check if copy button already exists
      if (!header.querySelector('.code-copy-btn')) {
        const copyBtn = document.createElement('button');
        copyBtn.className = 'code-copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.setAttribute('aria-label', 'Copy code to clipboard');

        header.appendChild(copyBtn);

        // Attach event listener
        copyBtn.addEventListener('click', function() {
          const codeContent = codeBlock.querySelector('.code-content code, .code-content pre');
          if (codeContent) {
            const textToCopy = (codeContent.textContent || codeContent.innerText).trim();

            copyToClipboard(textToCopy)
              .then(function() {
                showCopyFeedback(copyBtn, true);
              })
              .catch(function(err) {
                console.error('Failed to copy:', err);
                showCopyFeedback(copyBtn, false);
              });
          }
        });
      }

      codeBlock.classList.add('has-copy-btn');
    });
  }

  // ========== Initialize ==========
  function init() {
    // Wait for DOM to be fully loaded
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        initCopyButtons();
        addCopyButtonsToCodeBlocks();
      });
    } else {
      // DOM is already loaded
      initCopyButtons();
      addCopyButtonsToCodeBlocks();
    }
  }

  // Start initialization
  init();

})();
