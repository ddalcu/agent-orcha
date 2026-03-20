export default {
    name: "hello",
    description: "Say hello",
    parameters: {
        name: { type: "string", description: "Name to greet" }
    },
    execute: async ({ name }) => {
        return `Hello, ${name}!`;
    }
};
