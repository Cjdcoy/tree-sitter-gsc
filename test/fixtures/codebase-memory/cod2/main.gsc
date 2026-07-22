#include FixtureAlias\helper;

main()
{
    local_target();
    FixtureAlias\helper::qualified_target();
    ambiguous_target();
}

local_target()
{
    return "local";
}
